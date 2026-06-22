import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/api/dialog";
import { open as shellOpen } from "@tauri-apps/api/shell";
import { desktopDir } from "@tauri-apps/api/path";

interface ImageInfo {
  path: string;
  filename: string;
  size_mb: number;
  sort_time: string;
  sort_method: string;
  unix_ts: number;
  width: number;
  height: number;
}

interface ProgressPayload {
  percent: number;
  message: string;
}

type Status = "idle" | "scanning" | "converting" | "done" | "error";

const METHOD_LABEL: Record<string, string> = {
  exif: "EXIF",
  filename: "파일명",
  mtime: "수정시간",
};

export default function App() {
  const [images, setImages]               = useState<ImageInfo[]>([]);
  const [fps, setFps]                     = useState(60);
  const [framesPerPhoto, setFramesPerPhoto] = useState(2);
  const [outputPath, setOutputPath]       = useState("");
  const [outputWidth, setOutputWidth]     = useState(() => Number(localStorage.getItem("orientW")) || 1080);
  const [outputHeight, setOutputHeight]   = useState(() => Number(localStorage.getItem("orientH")) || 1920);
  const [deflicker, setDeflicker]         = useState(false);
  const [status, setStatus]               = useState<Status>("idle");
  const [progress, setProgress]           = useState(0);
  const [progressMsg, setProgressMsg]     = useState("");
  const [errorMsg, setErrorMsg]           = useState("");
  const [isDragOver, setIsDragOver]       = useState(false);

  const totalFrames  = images.length * framesPerPhoto;
  const durationSec  = fps > 0 ? totalFrames / fps : 0;

  // File drop listeners
  useEffect(() => {
    let unDrop: (() => void) | undefined;
    let unHover: (() => void) | undefined;
    let unCancel: (() => void) | undefined;

    (async () => {
      unDrop   = await listen<string[]>("tauri://file-drop", (e) => {
        setIsDragOver(false);
        handleDrop(e.payload);
      });
      unHover  = await listen("tauri://file-drop-hover",     () => setIsDragOver(true));
      unCancel = await listen("tauri://file-drop-cancelled", () => setIsDragOver(false));
    })();

    return () => { unDrop?.(); unHover?.(); unCancel?.(); };
  }, []);

  // Progress listener
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await listen<ProgressPayload>("progress", (e) => {
        setProgress(e.payload.percent);
        setProgressMsg(e.payload.message);
      });
    })();
    return () => unlisten?.();
  }, []);

  // Persist orientation setting
  useEffect(() => {
    if (outputWidth > 0 && outputHeight > 0) {
      localStorage.setItem("orientW", String(outputWidth));
      localStorage.setItem("orientH", String(outputHeight));
    }
  }, [outputWidth, outputHeight]);

  // Default output path
  useEffect(() => {
    desktopDir().then((d) => setOutputPath(`${d}timelapse.mp4`));
  }, []);

  async function handleDrop(paths: string[]) {
    if (status === "converting") return;
    setStatus("scanning");
    setErrorMsg("");
    try {
      const result = await invoke<ImageInfo[]>("scan_images", { paths });
      setImages((prev) => {
        const existingPaths = new Set(prev.map((i) => i.path));
        const merged = [...prev, ...result.filter((i) => !existingPaths.has(i.path))];
        merged.sort((a, b) => a.unix_ts - b.unix_ts);

        // Auto-detect orientation from first image (only if not already set)
        if (outputWidth === 0 && merged.length > 0 && merged[0].width > 0) {
          const first = merged[0];
          if (first.height > first.width) {
            setOutputWidth(1080); setOutputHeight(1920); // 세로 (Shorts)
          } else {
            setOutputWidth(1920); setOutputHeight(1080); // 가로
          }
        }

        return merged;
      });
      setStatus("idle");
    } catch (e) {
      setErrorMsg(String(e));
      setStatus("error");
    }
  }

  async function chooseOutput() {
    const path = await save({
      filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
      defaultPath: outputPath || "timelapse.mp4",
    });
    if (path) setOutputPath(path);
  }

  async function handleConvert() {
    if (!outputPath || images.length === 0 || status === "converting") return;
    setStatus("converting");
    setProgress(0);
    setProgressMsg("시작 중...");
    setErrorMsg("");
    try {
      await invoke("make_video", {
        images: images.map((i) => i.path),
        fps,
        framesPerPhoto,
        outputPath,
        outputWidth:  outputWidth  || 1080,
        outputHeight: outputHeight || 1920,
        deflicker,
      });
      setStatus("done");
    } catch (e) {
      setErrorMsg(String(e));
      setStatus("error");
    }
  }

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
    if (status === "done" || status === "error") setStatus("idle");
  }

  function clearAll() {
    setImages([]);
    setStatus("idle");
    setErrorMsg("");
    setOutputWidth(0);
    setOutputHeight(0);
  }

  function toggleOrientation() {
    setOutputWidth(() => outputHeight);
    setOutputHeight(() => outputWidth);
  }

  function openOutputFolder() {
    const folder = outputPath.replace(/[^\\/]*$/, "");
    shellOpen(folder);
  }

  function fmtDuration(sec: number) {
    if (sec < 60) return `${sec.toFixed(1)}초`;
    return `${Math.floor(sec / 60)}분 ${Math.round(sec % 60)}초`;
  }

  const isConverting = status === "converting";
  const canConvert   = images.length > 0 && !!outputPath && !isConverting;

  let convertClass = "btn-convert";
  if (canConvert)    convertClass += " ready";
  if (isConverting)  convertClass += " busy";

  return (
    <div className="app">
      {/* Titlebar */}
      <div className="titlebar">
        <span style={{ fontSize: 16 }}>🎬</span>
        <span className="titlebar-title">TimeLapse Maker</span>
        {images.length > 0 && (
          <span className="titlebar-badge">{images.length}장</span>
        )}
      </div>

      <div className="main-layout">
        {/* ── Left: drop zone / file list ── */}
        <div className="left-panel">
          {images.length === 0 ? (
            <div className={`drop-zone${isDragOver ? " over" : ""}`}>
              <div className="drop-icon">📂</div>
              <p className="drop-title">사진 폴더를 드래그하세요</p>
              <p className="drop-sub" style={{ marginTop: 4 }}>JPG · PNG · HEIC · 폴더 통째로 드롭 가능</p>
              <p className="drop-sub" style={{ color: "var(--fg3)", fontSize: 11 }}>mp4 파일은 자동으로 제외됩니다</p>
            </div>
          ) : (
            <div className="file-panel">
              <div className="file-header">
                <span className="file-count">
                  {images.length}장 &mdash; 시간순 정렬
                </span>
                <button className="btn-ghost" onClick={clearAll} disabled={isConverting}>
                  전체 제거
                </button>
              </div>

              <div className="file-list">
                {images.map((img, i) => (
                  <div className="file-item" key={img.path}>
                    <div className="file-num">{i + 1}</div>
                    <div className="file-info">
                      <span className="file-name">{img.filename}</span>
                      <span className="file-meta">
                        {img.sort_time}
                        <span className={`badge badge-${img.sort_method}`}>
                          {METHOD_LABEL[img.sort_method] ?? img.sort_method}
                        </span>
                      </span>
                    </div>
                    <span className="file-size">{img.size_mb.toFixed(1)}MB</span>
                    <button
                      className="file-remove"
                      onClick={() => removeImage(i)}
                      disabled={isConverting}
                    >✕</button>
                  </div>
                ))}
              </div>

              {isDragOver && (
                <div className="drop-overlay">+ 여기에 놓으면 추가됩니다</div>
              )}
            </div>
          )}
        </div>

        {/* ── Right: settings ── */}
        <div className="right-panel">
          {/* FPS */}
          <div className="settings-group">
            <label className="settings-label">출력 FPS</label>
            <div className="fps-btns">
              {[24, 30, 60].map((f) => (
                <button
                  key={f}
                  className={`fps-btn${fps === f ? " active" : ""}`}
                  onClick={() => setFps(f)}
                  disabled={isConverting}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {/* Frames per photo */}
          <div className="settings-group">
            <div className="settings-row">
              <label className="settings-label">장당 프레임 수</label>
              <span className="settings-val">{framesPerPhoto}f</span>
            </div>
            <input
              type="range"
              min={1}
              max={15}
              step={1}
              value={framesPerPhoto}
              onChange={(e) => setFramesPerPhoto(Number(e.target.value))}
              disabled={isConverting}
              className="slider"
            />
            <div className="slider-hints">
              <span>1 (빠름)</span>
              <span>15 (느림)</span>
            </div>
          </div>

          {/* Resolution */}
          <div className="settings-group">
            <label className="settings-label">출력 해상도</label>
            {outputWidth > 0 ? (
              <div className="res-box">
                <div className="res-info">
                  <span className="res-orient">
                    {outputHeight > outputWidth ? "세로 (Shorts/Reels)" : "가로 (YouTube)"}
                  </span>
                  <span className="res-value">{outputWidth} × {outputHeight}</span>
                </div>
                <button
                  className="btn-toggle"
                  onClick={toggleOrientation}
                  disabled={isConverting}
                  title="가로/세로 전환"
                >↔</button>
              </div>
            ) : (
              <div className="res-box">
                <span style={{ color: "var(--fg3)", fontSize: 12 }}>사진 드롭 후 자동 감지</span>
              </div>
            )}
          </div>

          {/* Deflicker */}
          <div className="settings-group">
            <label className="settings-row" style={{ cursor: "pointer" }}>
              <span className="settings-label">색감 보정 (플리커 제거)</span>
              <input
                type="checkbox"
                checked={deflicker}
                onChange={(e) => setDeflicker(e.target.checked)}
                disabled={isConverting}
                style={{ width: 16, height: 16, cursor: "pointer" }}
              />
            </label>
            {deflicker && (
              <p style={{ fontSize: 11, color: "var(--fg3)", marginTop: 4 }}>
                인접 프레임 색감을 균일화합니다. 인코딩이 느려질 수 있습니다.
              </p>
            )}
          </div>

          {/* Output path */}
          <div className="settings-group">
            <label className="settings-label">저장 위치</label>
            <div className="out-row">
              <div className="out-path" title={outputPath}>
                {outputPath || "저장 위치를 선택하세요"}
              </div>
              <button className="btn-icon" onClick={chooseOutput} disabled={isConverting} title="저장 위치 선택">
                📁
              </button>
            </div>
          </div>

          {/* Stats */}
          {images.length > 0 && (
            <div className="stat-card">
              <div className="stat-row">
                <span>이미지 수</span>
                <span className="stat-val">{images.length}장</span>
              </div>
              <div className="stat-row">
                <span>총 프레임</span>
                <span className="stat-val">{totalFrames}f</span>
              </div>
              <div className="stat-row">
                <span>예상 길이</span>
                <span className="stat-val accent">{fmtDuration(durationSec)}</span>
              </div>
            </div>
          )}

          {/* Progress */}
          {isConverting && (
            <div className="progress-wrap">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <span className="progress-msg">{progressMsg}</span>
            </div>
          )}

          {/* Done */}
          {status === "done" && (
            <div className="result-card ok">
              <span>✅ 영상 완성!</span>
              <button className="btn-open" onClick={openOutputFolder}>
                폴더 열기
              </button>
            </div>
          )}

          {/* Error */}
          {(status === "error" || (errorMsg && status !== "converting")) && (
            <div className="result-card err">
              <span>❌ {errorMsg}</span>
            </div>
          )}

          <div className="spacer" />

          <button className={convertClass} onClick={handleConvert} disabled={!canConvert}>
            {isConverting
              ? `변환 중... ${Math.round(progress)}%`
              : "🎬  영상 만들기"}
          </button>
        </div>
      </div>
    </div>
  );
}
