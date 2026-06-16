#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use std::{fs, io::Write, path::Path};
use serde::{Deserialize, Serialize};
use chrono::NaiveDateTime;
use regex::Regex;
use tokio::io::AsyncBufReadExt;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImageInfo {
    pub path:        String,
    pub filename:    String,
    pub size_mb:     f64,
    pub sort_time:   String,
    pub sort_method: String, // "exif" | "filename" | "mtime"
    pub unix_ts:     i64,
    pub width:       u32,
    pub height:      u32,
}

#[derive(Serialize, Clone)]
struct ProgressEvent {
    percent: f32,
    message: String,
}

// ── Dimension helper ──────────────────────────────────────────────────────

fn get_image_dims(path: &str) -> (u32, u32) {
    use exif::{In, Tag, Value};
    let file = match fs::File::open(path) { Ok(f) => f, Err(_) => return (0, 0) };
    let exif = match exif::Reader::new().read_from_container(&mut std::io::BufReader::new(file)) {
        Ok(e) => e, Err(_) => return (0, 0),
    };
    let read = |tag| -> u32 {
        exif.get_field(tag, In::PRIMARY).and_then(|f| match &f.value {
            Value::Long(v)  => v.first().copied(),
            Value::Short(v) => v.first().map(|&x| x as u32),
            _ => None,
        }).unwrap_or(0)
    };
    (read(Tag::PixelXDimension), read(Tag::PixelYDimension))
}

// ── Sort-time helpers ──────────────────────────────────────────────────────

fn try_exif_time(path: &str) -> Option<i64> {
    use exif::{In, Tag, Value};
    let file = fs::File::open(path).ok()?;
    let exif = exif::Reader::new()
        .read_from_container(&mut std::io::BufReader::new(file))
        .ok()?;
    let field = exif.get_field(Tag::DateTimeOriginal, In::PRIMARY)?;
    if let Value::Ascii(ref vec) = field.value {
        for bytes in vec {
            let s = std::str::from_utf8(bytes).ok()?.trim_end_matches('\0');
            if let Ok(dt) = NaiveDateTime::parse_from_str(s, "%Y:%m:%d %H:%M:%S") {
                return Some(dt.and_utc().timestamp());
            }
        }
    }
    None
}

fn try_filename_time(filename: &str) -> Option<i64> {
    // Matches YYYYMMDD_HHMMSS anywhere in the filename (Galaxy / most cameras)
    let re = Regex::new(r"(\d{8})_(\d{6})").ok()?;
    let caps = re.captures(filename)?;
    let s = format!("{} {}", &caps[1], &caps[2]);
    let dt = NaiveDateTime::parse_from_str(&s, "%Y%m%d %H%M%S").ok()?;
    Some(dt.and_utc().timestamp())
}

fn file_mtime(path: &str) -> Option<i64> {
    let meta = fs::metadata(path).ok()?;
    Some(
        meta.modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs() as i64,
    )
}

fn build_info(path: &str) -> Option<ImageInfo> {
    let p = Path::new(path);
    let ext = p.extension()?.to_string_lossy().to_lowercase();
    if !matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "heic" | "heif" | "webp") {
        return None;
    }
    let filename = p.file_name()?.to_string_lossy().to_string();
    let size_mb  = fs::metadata(path).map(|m| m.len() as f64 / 1_048_576.0).unwrap_or(0.0);

    let (unix_ts, sort_method) = if let Some(ts) = try_exif_time(path) {
        (ts, "exif")
    } else if let Some(ts) = try_filename_time(&filename) {
        (ts, "filename")
    } else if let Some(ts) = file_mtime(path) {
        (ts, "mtime")
    } else {
        return None;
    };

    let sort_time = chrono::DateTime::from_timestamp(unix_ts, 0)
        .map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_default();

    let (width, height) = get_image_dims(path);

    Some(ImageInfo {
        path: path.to_string(),
        filename,
        size_mb,
        sort_time,
        sort_method: sort_method.to_string(),
        unix_ts,
        width,
        height,
    })
}

// ── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
fn scan_images(paths: Vec<String>) -> Vec<ImageInfo> {
    let mut images = Vec::new();
    for path in &paths {
        let p = Path::new(path);
        if p.is_dir() {
            if let Ok(entries) = fs::read_dir(p) {
                for entry in entries.flatten() {
                    let child = entry.path().to_string_lossy().to_string();
                    if let Some(info) = build_info(&child) {
                        images.push(info);
                    }
                }
            }
        } else if let Some(info) = build_info(path) {
            images.push(info);
        }
    }
    images.sort_by_key(|i| i.unix_ts);
    images
}

#[tauri::command]
async fn make_video(
    window: tauri::Window,
    images: Vec<String>,
    fps: u32,
    frames_per_photo: u32,
    output_path: String,
    output_width: u32,
    output_height: u32,
    deflicker: bool,
) -> Result<(), String> {
    if images.is_empty() {
        return Err("이미지가 없습니다.".into());
    }

    // Verify FFmpeg is available
    tokio::process::Command::new("ffmpeg")
        .arg("-version")
        .output()
        .await
        .map_err(|_| "FFmpeg를 찾을 수 없습니다. FFmpeg를 설치하고 PATH에 추가해주세요.\n(https://ffmpeg.org/download.html)".to_string())?;

    // Write concat list to a temp file
    let duration = frames_per_photo as f64 / fps as f64;
    let list_path = std::env::temp_dir().join("timelapse_concat.txt");

    {
        let mut f = fs::File::create(&list_path).map_err(|e| e.to_string())?;
        for (i, img) in images.iter().enumerate() {
            let fwd = img.replace('\\', "/");
            writeln!(f, "file '{fwd}'").map_err(|e| e.to_string())?;
            writeln!(f, "duration {duration:.6}").map_err(|e| e.to_string())?;
            // Repeat last entry so the concat demuxer shows it for its full duration
            if i == images.len() - 1 {
                writeln!(f, "file '{fwd}'").map_err(|e| e.to_string())?;
            }
        }
    }

    let _ = window.emit("progress", ProgressEvent { percent: 0.0, message: "FFmpeg 시작 중...".into() });

    let total_frames = images.len() as f32 * frames_per_photo as f32;

    // Build scale filter: Lanczos downsampling + unsharp for sharpness recovery
    let deflicker_filter = if deflicker { "deflicker=size=10:mode=pm," } else { "" };
    let scale_filter = if output_width > 0 && output_height > 0 {
        format!("{}scale={}:{}:flags=lanczos,unsharp=3:3:0.8:3:3:0.4", deflicker_filter, output_width, output_height)
    } else {
        format!("{}scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos,unsharp=3:3:0.8:3:3:0.4", deflicker_filter)
    };

    let mut child = tokio::process::Command::new("ffmpeg")
        .args([
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", list_path.to_str().unwrap(),
            "-vf", &scale_filter,
            "-c:v", "libx264",
            "-crf", "16",
            "-preset", "veryslow",
            "-pix_fmt", "yuv420p",
            "-r", &fps.to_string(),
            "-progress", "pipe:1",
            "-nostats",
            &output_path,
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("FFmpeg 실행 실패: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(rest) = line.strip_prefix("frame=") {
                if let Ok(frame) = rest.trim().parse::<u32>() {
                    let pct = (frame as f32 / total_frames * 100.0).min(99.0);
                    let _ = window.emit("progress", ProgressEvent {
                        percent: pct,
                        message: format!("변환 중... {frame}/{} 프레임", total_frames as u32),
                    });
                }
            }
        }
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&list_path);

    if status.success() {
        let _ = window.emit("progress", ProgressEvent { percent: 100.0, message: "완료!".into() });
        Ok(())
    } else {
        Err("FFmpeg 변환 실패. 이미지 경로나 형식을 확인해주세요.".into())
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![scan_images, make_video])
        .run(tauri::generate_context!())
        .expect("error while running timelapse maker");
}
