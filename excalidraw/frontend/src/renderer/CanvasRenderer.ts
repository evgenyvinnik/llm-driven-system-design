import type { ExcalidrawElement, ViewState } from '../types';
import {
  renderRectangle,
  renderEllipse,
  renderDiamond,
  renderLine,
  renderArrow,
  renderFreehand,
  renderText,
} from './shapes';

/**
 * Main canvas renderer.
 * Renders all elements to a canvas context with proper viewport transforms.
 */
/** Renders all drawing elements onto the HTML5 canvas with viewport transformations. */
export const renderCanvas = (
  ctx: CanvasRenderingContext2D,
  elements: ExcalidrawElement[],
  viewState: ViewState,
  selectedElementId: string | null,
  canvasWidth: number,
  canvasHeight: number,
  pixelRatio: number = 1,
  draft: ExcalidrawElement | null = null
): void => {
  // Screen space: CSS pixels scaled to the backing store's device pixels.
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // Draw grid background
  drawGrid(ctx, viewState, canvasWidth, canvasHeight);

  // World space. setTransform REPLACES the current matrix, so the pixel ratio
  // has to be folded in here; replacing it with the bare viewport transform
  // drew every shape at 1/pixelRatio size while hit testing assumed full size.
  ctx.save();
  ctx.setTransform(
    pixelRatio * viewState.zoom,
    0,
    0,
    pixelRatio * viewState.zoom,
    pixelRatio * viewState.scrollX,
    pixelRatio * viewState.scrollY
  );

  // Render all visible elements
  for (const element of elements) {
    if (element.isDeleted) continue;

    ctx.save();
    renderElement(ctx, element);
    ctx.restore();
  }

  // The shape being drawn, before it is committed
  if (draft) {
    ctx.save();
    renderElement(ctx, draft);
    ctx.restore();
  }

  // Draw selection handles for selected element
  if (selectedElementId) {
    const selected = elements.find((el) => el.id === selectedElementId && !el.isDeleted);
    if (selected) {
      drawSelectionBox(ctx, selected);
    }
  }

  ctx.restore();
};

/**
 * Render a single element based on its type.
 */
const renderElement = (ctx: CanvasRenderingContext2D, element: ExcalidrawElement): void => {
  switch (element.type) {
    case 'rectangle':
      renderRectangle(ctx, element);
      break;
    case 'ellipse':
      renderEllipse(ctx, element);
      break;
    case 'diamond':
      renderDiamond(ctx, element);
      break;
    case 'line':
      renderLine(ctx, element);
      break;
    case 'arrow':
      renderArrow(ctx, element);
      break;
    case 'freehand':
      renderFreehand(ctx, element);
      break;
    case 'text':
      renderText(ctx, element);
      break;
  }
  ctx.globalAlpha = 1;
};

/**
 * Draw a dot grid background.
 */
const drawGrid = (
  ctx: CanvasRenderingContext2D,
  viewState: ViewState,
  canvasWidth: number,
  canvasHeight: number
): void => {
  const gridSize = 20;
  const dotSize = 1;
  const zoom = viewState.zoom;

  // Calculate visible grid range
  const startX = Math.floor(-viewState.scrollX / zoom / gridSize) * gridSize;
  const startY = Math.floor(-viewState.scrollY / zoom / gridSize) * gridSize;
  const endX = startX + Math.ceil(canvasWidth / zoom / gridSize) * gridSize + gridSize;
  const endY = startY + Math.ceil(canvasHeight / zoom / gridSize) * gridSize + gridSize;

  ctx.fillStyle = '#ddd';

  for (let x = startX; x <= endX; x += gridSize) {
    for (let y = startY; y <= endY; y += gridSize) {
      const screenX = x * zoom + viewState.scrollX;
      const screenY = y * zoom + viewState.scrollY;
      ctx.fillRect(screenX - dotSize / 2, screenY - dotSize / 2, dotSize, dotSize);
    }
  }
};

/**
 * Draw selection box and handles around a selected element.
 */
const drawSelectionBox = (ctx: CanvasRenderingContext2D, element: ExcalidrawElement): void => {
  const padding = 4;
  const handleSize = 8;
  const x = element.x - padding;
  const y = element.y - padding;
  const w = element.width + padding * 2;
  const h = element.height + padding * 2;

  // Selection rectangle
  ctx.strokeStyle = '#6965db';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 5]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);

  // Corner handles
  const corners = [
    { x, y },                              // top-left
    { x: x + w, y },                       // top-right
    { x: x + w, y: y + h },              // bottom-right
    { x, y: y + h },                       // bottom-left
  ];

  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#6965db';
  ctx.lineWidth = 2;

  for (const corner of corners) {
    ctx.fillRect(corner.x - handleSize / 2, corner.y - handleSize / 2, handleSize, handleSize);
    ctx.strokeRect(corner.x - handleSize / 2, corner.y - handleSize / 2, handleSize, handleSize);
  }
};

export default renderCanvas;
