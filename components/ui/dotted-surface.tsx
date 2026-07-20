"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Animated dotted surface: a perspective plane of dots rippling with sine
 * waves, receding toward a horizon. Canvas 2D — no three.js dependency.
 */
export function DottedSurface({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Grid / camera setup
    const GAP = 18; // world spacing between dots
    const COLS = 170; // across
    const ROWS = 115; // into the distance
    const FOCAL = 260; // perspective strength
    const CAM_Y = 30; // camera height above the plane
    const Z_NEAR = 62; // push the nearest row back so dots stay small
    const AMPLITUDE = 9;
    const MAX_DOT = 2.6; // dots stay fine, never blocky

    let w = 0;
    let h = 0;
    let dpr = 1;
    let t = 0;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2;
      // Horizon sits low so the field reads as a floor under the UI.
      const horizonY = h * 0.7;

      ctx.fillStyle = "#ffffff";

      for (let r = 0; r < ROWS; r++) {
        const z = Z_NEAR + r * GAP;
        const scale = FOCAL / z;

        // Fade dots out as they approach the horizon.
        const depthFade = Math.min(1, Math.max(0, (1 - r / ROWS) * 1.6));
        if (depthFade <= 0.01) continue;

        const size = Math.min(MAX_DOT, Math.max(0.8, scale * 0.85));
        const rowAlpha = Math.min(1, scale * 0.5) * depthFade;
        if (rowAlpha <= 0.02) continue;
        ctx.globalAlpha = rowAlpha;

        for (let c = 0; c < COLS; c++) {
          const x = (c - COLS / 2) * GAP;
          const px = cx + x * scale;
          if (px < -20 || px > w + 20) continue;

          // Two crossing sine waves for the rippling surface.
          const wave =
            Math.sin(x * 0.0055 + t) * AMPLITUDE +
            Math.sin(z * 0.009 + t * 0.85) * AMPLITUDE;

          const py = horizonY + (CAM_Y + wave) * scale;
          if (py < horizonY - 40 || py > h + 20) continue;

          ctx.fillRect(px, py, size, size);
        }
      }

      ctx.globalAlpha = 1;
      t += 0.011; // slow, gentle swell
      rafRef.current = requestAnimationFrame(draw);
    };

    resize();
    rafRef.current = requestAnimationFrame(draw);
    window.addEventListener("resize", resize);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div className={cn("dotted-surface", className)} aria-hidden="true">
      <canvas ref={canvasRef} className="dotted-surface-canvas" />
      {/* soft grey/white glow through the middle */}
      <div className="dotted-surface-glow" />
    </div>
  );
}

export default DottedSurface;
