/** Custom frameless title bar: drag region + window control buttons. */

const btnBase =
  "h-8 w-10 flex items-center justify-center text-xs text-text-muted " +
  "transition-colors select-none";

export default function TitleBar() {
  const hasControls = typeof window !== "undefined" && !!window.electronAPI;

  return (
    <div
      className="h-8 flex items-stretch justify-between bg-canvas border-b border-edge shrink-0"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {/* Branding */}
      <div className="flex items-center gap-2 px-3">
        <span className="w-2 h-2 rounded-full bg-neon shadow-glow-sm" />
        <span className="font-mono uppercase tracking-wider text-xs font-bold text-neon">
          AI&nbsp;Employer
        </span>
      </div>

      {/* Window controls — clickable, so excluded from the drag region */}
      <div className="flex items-stretch" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        {hasControls ? (
          <>
            <button
              className={`${btnBase} hover:bg-edge hover:text-text-primary`}
              onClick={() => window.electronAPI?.minimize()}
              title="Minimize"
            >
              −
            </button>
            <button
              className={`${btnBase} hover:bg-edge hover:text-text-primary`}
              onClick={() => window.electronAPI?.maximize()}
              title="Maximize"
            >
              □
            </button>
            <button
              className={`${btnBase} hover:bg-danger-strong hover:text-white`}
              onClick={() => window.electronAPI?.close()}
              title="Close"
            >
              ✕
            </button>
          </>
        ) : (
          // Browser (no Electron bridge): render inert placeholders to keep
          // the layout identical during Vite-only development.
          <div className="flex items-stretch opacity-30">
            <span className={btnBase}>−</span>
            <span className={btnBase}>□</span>
            <span className={btnBase}>✕</span>
          </div>
        )}
      </div>
    </div>
  );
}