import type { DesignObject } from '../types';

interface DesignThumbnailProps {
  objects: DesignObject[];
}

/**
 * Renders a static SVG preview of a design's objects for the file-browser card.
 *
 * The live editor draws on a PixiJS/WebGL canvas, which headless screenshot
 * capture can't composite — and a thumbnail doesn't need interactivity anyway.
 * An SVG projection of the same objects gives a real, visible preview that works
 * everywhere, auto-fitted to the card via a computed bounding-box viewBox.
 */
export function DesignThumbnail({ objects }: DesignThumbnailProps) {
  const visible = objects.filter((o) => o.visible !== false);
  if (visible.length === 0) {
    return (
      <svg className="w-12 h-12 text-figma-border" viewBox="0 0 24 24" fill="currentColor">
        <path d="M3 3h18v18H3V3zm2 2v14h14V5H5z" />
      </svg>
    );
  }

  // Bounding box over all objects, with a little padding.
  const minX = Math.min(...visible.map((o) => o.x));
  const minY = Math.min(...visible.map((o) => o.y));
  const maxX = Math.max(...visible.map((o) => o.x + (o.width ?? 0)));
  const maxY = Math.max(...visible.map((o) => o.y + (o.height ?? 0)));
  const pad = 24;
  const vbX = minX - pad;
  const vbY = minY - pad;
  const vbW = Math.max(maxX - minX + pad * 2, 1);
  const vbH = Math.max(maxY - minY + pad * 2, 1);

  return (
    <svg
      className="w-full h-full"
      viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {visible.map((o) => {
        const stroke = o.strokeWidth ? o.stroke : "none";
        const strokeWidth = o.strokeWidth ?? 0;
        switch (o.type) {
          case 'ellipse':
            return (
              <ellipse
                key={o.id}
                cx={o.x + (o.width ?? 0) / 2}
                cy={o.y + (o.height ?? 0) / 2}
                rx={(o.width ?? 0) / 2}
                ry={(o.height ?? 0) / 2}
                fill={o.fill || '#334155'}
                stroke={stroke}
                strokeWidth={strokeWidth}
              />
            );
          case 'text':
            return (
              <text
                key={o.id}
                x={o.x}
                y={o.y + (o.fontSize ?? 16)}
                fontSize={o.fontSize ?? 16}
                fill={o.fill || '#e2e8f0'}
                fontFamily="sans-serif"
              >
                {o.text}
              </text>
            );
          default:
            return (
              <rect
                key={o.id}
                x={o.x}
                y={o.y}
                width={o.width ?? 0}
                height={o.height ?? 0}
                rx={4}
                fill={o.fill || '#334155'}
                stroke={stroke}
                strokeWidth={strokeWidth}
              />
            );
        }
      })}
    </svg>
  );
}
