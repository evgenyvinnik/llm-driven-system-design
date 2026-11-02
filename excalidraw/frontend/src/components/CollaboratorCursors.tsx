import type { Cursor } from '../types';

interface CollaboratorCursorsProps {
  cursors: Cursor[];
  scrollX: number;
  scrollY: number;
  zoom: number;
}

/** Renders colored cursor pointers for remote collaborators on the canvas. */
export function CollaboratorCursors({ cursors, scrollX, scrollY, zoom }: CollaboratorCursorsProps) {
  return (
    <>
      {cursors.map((cursor) => {
        const screenX = cursor.x * zoom + scrollX;
        const screenY = cursor.y * zoom + scrollY;

        return (
          <div
            key={cursor.clientId}
            className="absolute pointer-events-none z-50 transition-all duration-75"
            style={{
              left: screenX,
              top: screenY,
              transform: 'translate(-2px, -2px)',
            }}
          >
            {/* Cursor arrow */}
            <svg
              width="16"
              height="20"
              viewBox="0 0 16 20"
              fill="none"
              className="drop-shadow-sm"
            >
              <path
                d="M0 0L16 12L8 12L4 20L0 0Z"
                fill={cursor.color}
                stroke="white"
                strokeWidth="1"
              />
            </svg>
            {/* Username label */}
            <div
              className="absolute top-5 left-3 px-1.5 py-0.5 rounded text-xs text-white whitespace-nowrap shadow-sm"
              style={{ backgroundColor: cursor.color }}
            >
              {cursor.username}
            </div>
          </div>
        );
      })}
    </>
  );
}
