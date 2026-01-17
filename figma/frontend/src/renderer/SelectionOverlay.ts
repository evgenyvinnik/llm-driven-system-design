import * as PIXI from 'pixi.js';
import type { DesignObject } from '../types';

/**
 * Handles rendering selection outlines and resize handles
 */
export class SelectionOverlay {
  private container: PIXI.Container;
  private graphics: PIXI.Graphics;

  constructor() {
    this.container = new PIXI.Container();
    this.graphics = new PIXI.Graphics();
    this.container.addChild(this.graphics);
  }

  public getContainer(): PIXI.Container {
    return this.container;
  }

  /**
   * Render selection outlines and handles for selected objects
   */
  public render(selectedObjects: DesignObject[], zoom: number): void {
    this.graphics.clear();

    if (selectedObjects.length === 0) return;

    const selectionColor = 0x0d99ff;
    const lineWidth = 2 / zoom;
    const handleSize = 8 / zoom;

    selectedObjects.forEach((obj) => {
      // Selection outline
      this.graphics.setStrokeStyle({ width: lineWidth, color: selectionColor });

      if (obj.type === 'ellipse') {
        // Ellipse selection outline
        const cx = obj.x + obj.width / 2;
        const cy = obj.y + obj.height / 2;
        const rx = obj.width / 2 + lineWidth;
        const ry = obj.height / 2 + lineWidth;
        this.graphics.ellipse(cx, cy, rx, ry);
        this.graphics.stroke();
      } else {
        // Rectangle selection outline
        this.graphics.rect(
          obj.x - lineWidth,
          obj.y - lineWidth,
          obj.width + lineWidth * 2,
          obj.height + lineWidth * 2
        );
        this.graphics.stroke();
      }

      // Draw resize handles
      this.drawResizeHandles(obj, handleSize, selectionColor);
    });
  }

  private drawResizeHandles(obj: DesignObject, handleSize: number, color: number): void {
    const handles = [
      { x: obj.x, y: obj.y }, // top-left
      { x: obj.x + obj.width / 2, y: obj.y }, // top-center
      { x: obj.x + obj.width, y: obj.y }, // top-right
      { x: obj.x + obj.width, y: obj.y + obj.height / 2 }, // right-center
      { x: obj.x + obj.width, y: obj.y + obj.height }, // bottom-right
      { x: obj.x + obj.width / 2, y: obj.y + obj.height }, // bottom-center
      { x: obj.x, y: obj.y + obj.height }, // bottom-left
      { x: obj.x, y: obj.y + obj.height / 2 }, // left-center
    ];

    handles.forEach((handle) => {
      // White fill
      this.graphics.fill({ color: 0xffffff });
      this.graphics.rect(
        handle.x - handleSize / 2,
        handle.y - handleSize / 2,
        handleSize,
        handleSize
      );
      this.graphics.fill();

      // Blue stroke
      this.graphics.setStrokeStyle({ width: 1, color });
      this.graphics.rect(
        handle.x - handleSize / 2,
        handle.y - handleSize / 2,
        handleSize,
        handleSize
      );
      this.graphics.stroke();
    });
  }

  /**
   * Render collaborator selections with their user colors
   */
  public renderCollaboratorSelections(
    objects: DesignObject[],
    selections: { userId: string; objectIds: string[]; color: string }[],
    zoom: number
  ): void {
    const lineWidth = 2 / zoom;

    selections.forEach(({ objectIds, color }) => {
      const colorNum = parseInt(color.replace('#', ''), 16);

      objectIds.forEach((objId) => {
        const obj = objects.find((o) => o.id === objId);
        if (!obj) return;

        this.graphics.setStrokeStyle({ width: lineWidth, color: colorNum });

        if (obj.type === 'ellipse') {
          const cx = obj.x + obj.width / 2;
          const cy = obj.y + obj.height / 2;
          const rx = obj.width / 2 + lineWidth * 2;
          const ry = obj.height / 2 + lineWidth * 2;
          this.graphics.ellipse(cx, cy, rx, ry);
        } else {
          this.graphics.rect(
            obj.x - lineWidth * 2,
            obj.y - lineWidth * 2,
            obj.width + lineWidth * 4,
            obj.height + lineWidth * 4
          );
        }
        this.graphics.stroke();
      });
    });
  }

  public clear(): void {
    this.graphics.clear();
  }

  public destroy(): void {
    this.graphics.destroy();
    this.container.destroy();
  }
}
