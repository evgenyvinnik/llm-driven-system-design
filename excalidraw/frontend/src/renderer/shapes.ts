import type { ExcalidrawElement } from '../types';

/**
 * Render a rectangle shape.
 */
export const renderRectangle = (ctx: CanvasRenderingContext2D, el: ExcalidrawElement): void => {
  ctx.beginPath();
  ctx.rect(el.x, el.y, el.width, el.height);

  if (el.fillColor && el.fillColor !== 'transparent') {
    ctx.fillStyle = el.fillColor;
    ctx.globalAlpha = el.opacity;
    ctx.fill();
  }

  ctx.strokeStyle = el.strokeColor;
  ctx.lineWidth = el.strokeWidth;
  ctx.globalAlpha = el.opacity;
  ctx.stroke();
};

/**
 * Render an ellipse shape.
 */
export const renderEllipse = (ctx: CanvasRenderingContext2D, el: ExcalidrawElement): void => {
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const rx = Math.abs(el.width) / 2;
  const ry = Math.abs(el.height) / 2;

  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);

  if (el.fillColor && el.fillColor !== 'transparent') {
    ctx.fillStyle = el.fillColor;
    ctx.globalAlpha = el.opacity;
    ctx.fill();
  }

  ctx.strokeStyle = el.strokeColor;
  ctx.lineWidth = el.strokeWidth;
  ctx.globalAlpha = el.opacity;
  ctx.stroke();
};

/**
 * Render a diamond shape (rotated square).
 */
export const renderDiamond = (ctx: CanvasRenderingContext2D, el: ExcalidrawElement): void => {
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;

  ctx.beginPath();
  ctx.moveTo(cx, el.y);          // top
  ctx.lineTo(el.x + el.width, cy); // right
  ctx.lineTo(cx, el.y + el.height); // bottom
  ctx.lineTo(el.x, cy);           // left
  ctx.closePath();

  if (el.fillColor && el.fillColor !== 'transparent') {
    ctx.fillStyle = el.fillColor;
    ctx.globalAlpha = el.opacity;
    ctx.fill();
  }

  ctx.strokeStyle = el.strokeColor;
  ctx.lineWidth = el.strokeWidth;
  ctx.globalAlpha = el.opacity;
  ctx.stroke();
};

/**
 * Render a line.
 */
export const renderLine = (ctx: CanvasRenderingContext2D, el: ExcalidrawElement): void => {
  ctx.beginPath();
  ctx.strokeStyle = el.strokeColor;
  ctx.lineWidth = el.strokeWidth;
  ctx.globalAlpha = el.opacity;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (el.points && el.points.length >= 2) {
    ctx.moveTo(el.x + el.points[0].x, el.y + el.points[0].y);
    for (let i = 1; i < el.points.length; i++) {
      ctx.lineTo(el.x + el.points[i].x, el.y + el.points[i].y);
    }
  } else {
    ctx.moveTo(el.x, el.y);
    ctx.lineTo(el.x + el.width, el.y + el.height);
  }

  ctx.stroke();
};

/**
 * Render an arrow (line with arrowhead).
 */
export const renderArrow = (ctx: CanvasRenderingContext2D, el: ExcalidrawElement): void => {
  ctx.strokeStyle = el.strokeColor;
  ctx.fillStyle = el.strokeColor;
  ctx.lineWidth = el.strokeWidth;
  ctx.globalAlpha = el.opacity;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  let endX: number, endY: number;
  let prevX: number, prevY: number;

  if (el.points && el.points.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(el.x + el.points[0].x, el.y + el.points[0].y);
    for (let i = 1; i < el.points.length; i++) {
      ctx.lineTo(el.x + el.points[i].x, el.y + el.points[i].y);
    }
    ctx.stroke();

    const lastPoint = el.points[el.points.length - 1];
    const prevPoint = el.points[el.points.length - 2];
    endX = el.x + lastPoint.x;
    endY = el.y + lastPoint.y;
    prevX = el.x + prevPoint.x;
    prevY = el.y + prevPoint.y;
  } else {
    ctx.beginPath();
    ctx.moveTo(el.x, el.y);
    ctx.lineTo(el.x + el.width, el.y + el.height);
    ctx.stroke();

    endX = el.x + el.width;
    endY = el.y + el.height;
    prevX = el.x;
    prevY = el.y;
  }

  // Draw arrowhead
  const angle = Math.atan2(endY - prevY, endX - prevX);
  const arrowLen = Math.max(10, el.strokeWidth * 4);

  ctx.beginPath();
  ctx.moveTo(endX, endY);
  ctx.lineTo(
    endX - arrowLen * Math.cos(angle - Math.PI / 6),
    endY - arrowLen * Math.sin(angle - Math.PI / 6)
  );
  ctx.moveTo(endX, endY);
  ctx.lineTo(
    endX - arrowLen * Math.cos(angle + Math.PI / 6),
    endY - arrowLen * Math.sin(angle + Math.PI / 6)
  );
  ctx.stroke();
};

/**
 * Render a freehand path.
 */
export const renderFreehand = (ctx: CanvasRenderingContext2D, el: ExcalidrawElement): void => {
  if (!el.points || el.points.length < 2) return;

  ctx.beginPath();
  ctx.strokeStyle = el.strokeColor;
  ctx.lineWidth = el.strokeWidth;
  ctx.globalAlpha = el.opacity;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.moveTo(el.x + el.points[0].x, el.y + el.points[0].y);

  // Use quadratic curves for smoother rendering
  if (el.points.length === 2) {
    ctx.lineTo(el.x + el.points[1].x, el.y + el.points[1].y);
  } else {
    for (let i = 1; i < el.points.length - 1; i++) {
      const xc = (el.x + el.points[i].x + el.x + el.points[i + 1].x) / 2;
      const yc = (el.y + el.points[i].y + el.y + el.points[i + 1].y) / 2;
      ctx.quadraticCurveTo(el.x + el.points[i].x, el.y + el.points[i].y, xc, yc);
    }
    // Last point
    const lastPoint = el.points[el.points.length - 1];
    ctx.lineTo(el.x + lastPoint.x, el.y + lastPoint.y);
  }

  ctx.stroke();
};

/**
 * Render a text element.
 */
export const renderText = (ctx: CanvasRenderingContext2D, el: ExcalidrawElement): void => {
  if (!el.text) return;

  const fontSize = el.fontSize || 16;
  ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
  ctx.fillStyle = el.strokeColor;
  ctx.globalAlpha = el.opacity;
  ctx.textBaseline = 'top';

  // Handle multi-line text
  const lines = el.text.split('\n');
  const lineHeight = fontSize * 1.4;

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], el.x, el.y + i * lineHeight);
  }
};
