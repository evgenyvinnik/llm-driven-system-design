/**
 * PixiJS-based renderer for the design canvas.
 * Provides hardware-accelerated rendering of design objects, selection overlays,
 * collaboration cursors, and the canvas grid. Handles viewport transformations
 * for pan and zoom functionality.
 */
import * as PIXI from 'pixi.js';
import type { DesignObject, Viewport, PresenceState } from '../types';
import { ShapeFactory } from './ShapeFactory';
import { SelectionOverlay } from './SelectionOverlay';

/**
 * Main renderer class for the design editor canvas.
 * Manages the PixiJS application, viewport container, and rendering pipeline.
 */
export class PixiRenderer {
  private app: PIXI.Application;
  private viewportContainer: PIXI.Container;
  private objectsContainer: PIXI.Container;
  private gridGraphics: PIXI.Graphics;
  private selectionOverlay: SelectionOverlay;
  private cursorContainer: PIXI.Container;
  private objectMap: Map<string, PIXI.Container>;
  private shapeFactory: ShapeFactory;
  private currentViewport: Viewport = { x: 0, y: 0, zoom: 1 };
  private isInitialized = false;

  /**
   * Creates a new PixiRenderer and attaches it to the given container.
   * Initializes asynchronously - check `initialized` before using.
   * @param container - The HTML div element to render into
   */
  constructor(container: HTMLDivElement) {
    // Create PixiJS Application
    this.app = new PIXI.Application();
    this.objectMap = new Map();

    // Create containers
    this.viewportContainer = new PIXI.Container();
    this.objectsContainer = new PIXI.Container();
    this.gridGraphics = new PIXI.Graphics();
    this.cursorContainer = new PIXI.Container();

    // Create helper classes
    this.shapeFactory = new ShapeFactory();
    this.selectionOverlay = new SelectionOverlay();

    // Initialize async
    this.init(container);
  }

  /**
   * Initializes the PixiJS application and sets up the render hierarchy.
   * @param container - The HTML element to attach the canvas to
   */
  private async init(container: HTMLDivElement): Promise<void> {
    await this.app.init({
      background: '#1E1E1E',
      resizeTo: container,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });

    // Add canvas to container
    container.appendChild(this.app.canvas);

    // Set up container hierarchy
    // viewportContainer handles pan/zoom transforms
    this.viewportContainer.addChild(this.gridGraphics);
    this.viewportContainer.addChild(this.objectsContainer);
    this.viewportContainer.addChild(this.selectionOverlay.getContainer());

    this.app.stage.addChild(this.viewportContainer);
    this.app.stage.addChild(this.cursorContainer); // Cursors in screen space

    // Enable interactivity
    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = this.app.screen;

    this.isInitialized = true;
  }

  /** Returns the PixiJS stage container */
  public get stage(): PIXI.Container {
    return this.app.stage;
  }

  /** Returns the underlying HTML canvas element */
  public get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  /** Returns whether the renderer has finished initialization */
  public get initialized(): boolean {
    return this.isInitialized;
  }

  /**
   * Updates the viewport pan and zoom.
   * @param viewport - The new viewport state with x, y, and zoom
   */
  public setViewport(viewport: Viewport): void {
    this.currentViewport = viewport;
    this.viewportContainer.position.set(viewport.x, viewport.y);
    this.viewportContainer.scale.set(viewport.zoom);
  }

  /**
   * Returns the current viewport state.
   * @returns The current viewport with x, y, and zoom values
   */
  public getViewport(): Viewport {
    return this.currentViewport;
  }

  /**
   * Main render function that updates all visual elements.
   * Should be called whenever canvas data, selection, or collaborators change.
   * @param objects - Array of design objects to render
   * @param selectedIds - IDs of currently selected objects
   * @param collaborators - Presence states of other collaborators
   */
  public render(
    objects: DesignObject[],
    selectedIds: string[],
    collaborators: PresenceState[]
  ): void {
    if (!this.isInitialized) return;

    // Draw grid
    this.drawGrid();

    // Sync objects
    this.syncObjects(objects);

    // Update selection overlay
    const selectedObjects = objects.filter((obj) => selectedIds.includes(obj.id));
    this.selectionOverlay.render(selectedObjects, this.currentViewport.zoom);

    // Draw collaborator cursors
    this.drawCursors(collaborators);
  }

  /**
   * Draws the background grid pattern.
   * Grid density adjusts based on zoom level.
   */
  private drawGrid(): void {
    const { zoom, x, y } = this.currentViewport;
    const width = this.app.screen.width;
    const height = this.app.screen.height;
    const gridSize = 20;

    this.gridGraphics.clear();
    this.gridGraphics.setStrokeStyle({ width: 0.5 / zoom, color: 0x333333 });

    const startX = Math.floor(-x / zoom / gridSize) * gridSize;
    const startY = Math.floor(-y / zoom / gridSize) * gridSize;
    const endX = startX + width / zoom + gridSize * 2;
    const endY = startY + height / zoom + gridSize * 2;

    for (let gx = startX; gx <= endX; gx += gridSize) {
      this.gridGraphics.moveTo(gx, startY);
      this.gridGraphics.lineTo(gx, endY);
    }

    for (let gy = startY; gy <= endY; gy += gridSize) {
      this.gridGraphics.moveTo(startX, gy);
      this.gridGraphics.lineTo(endX, gy);
    }

    this.gridGraphics.stroke();
  }

  /**
   * Synchronizes PixiJS display objects with the design object array.
   * Creates, updates, or removes objects as needed.
   * @param objects - The current array of design objects
   */
  private syncObjects(objects: DesignObject[]): void {
    const currentIds = new Set(objects.map((obj) => obj.id));

    // Remove objects that no longer exist
    for (const [id, container] of this.objectMap) {
      if (!currentIds.has(id)) {
        this.objectsContainer.removeChild(container);
        container.destroy({ children: true });
        this.objectMap.delete(id);
      }
    }

    // Add or update objects
    objects.forEach((obj, index) => {
      if (!obj.visible) {
        // Hide if not visible
        const existing = this.objectMap.get(obj.id);
        if (existing) {
          existing.visible = false;
        }
        return;
      }

      let container = this.objectMap.get(obj.id);

      if (!container) {
        // Create new object
        container = this.shapeFactory.createShape(obj);
        this.objectMap.set(obj.id, container);
        this.objectsContainer.addChild(container);
      } else {
        // Update existing object
        this.shapeFactory.updateShape(container, obj);
        container.visible = true;
      }

      // Update z-order
      this.objectsContainer.setChildIndex(container, index);
    });
  }

  /**
   * Draws collaborator cursors with names.
   * Positions cursors in screen space.
   * @param collaborators - Array of collaborator presence states
   */
  private drawCursors(collaborators: PresenceState[]): void {
    // Clear existing cursors
    this.cursorContainer.removeChildren();

    collaborators.forEach((collab) => {
      if (!collab.cursor) return;

      // Convert canvas coordinates to screen coordinates
      const screenX = collab.cursor.x * this.currentViewport.zoom + this.currentViewport.x;
      const screenY = collab.cursor.y * this.currentViewport.zoom + this.currentViewport.y;

      const cursorGraphic = this.createCursor(collab.userColor, collab.userName);
      cursorGraphic.position.set(screenX, screenY);
      this.cursorContainer.addChild(cursorGraphic);
    });
  }

  /**
   * Creates a cursor graphic with user color and name label.
   * @param color - The user's assigned color
   * @param name - The user's display name
   * @returns A PixiJS container with the cursor graphic
   */
  private createCursor(color: string, name: string): PIXI.Container {
    const container = new PIXI.Container();
    const colorNum = parseInt(color.replace('#', ''), 16);

    // Cursor arrow
    const cursor = new PIXI.Graphics();
    cursor.fill({ color: colorNum });
    cursor.moveTo(0, 0);
    cursor.lineTo(12, 10);
    cursor.lineTo(6, 10);
    cursor.lineTo(6, 16);
    cursor.lineTo(0, 16);
    cursor.closePath();
    cursor.fill();
    container.addChild(cursor);

    // Name label background
    const labelBg = new PIXI.Graphics();
    const textStyle = new PIXI.TextStyle({
      fontFamily: 'Inter, sans-serif',
      fontSize: 12,
      fill: 0xffffff,
    });
    const text = new PIXI.Text({ text: name, style: textStyle });
    const padding = 4;

    labelBg.fill({ color: colorNum });
    labelBg.roundRect(10, 14, text.width + padding * 2, 18, 3);
    labelBg.fill();
    container.addChild(labelBg);

    text.position.set(10 + padding, 15);
    container.addChild(text);

    return container;
  }

  /**
   * Converts screen (pixel) coordinates to canvas coordinates.
   * Accounts for viewport pan and zoom.
   * @param screenX - X position in screen pixels
   * @param screenY - Y position in screen pixels
   * @returns Canvas coordinates
   */
  public screenToCanvas(screenX: number, screenY: number): { x: number; y: number } {
    const rect = this.app.canvas.getBoundingClientRect();
    return {
      x: (screenX - rect.left - this.currentViewport.x) / this.currentViewport.zoom,
      y: (screenY - rect.top - this.currentViewport.y) / this.currentViewport.zoom,
    };
  }

  /**
   * Converts canvas coordinates to screen (pixel) coordinates.
   * Accounts for viewport pan and zoom.
   * @param canvasX - X position in canvas units
   * @param canvasY - Y position in canvas units
   * @returns Screen pixel coordinates
   */
  public canvasToScreen(canvasX: number, canvasY: number): { x: number; y: number } {
    return {
      x: canvasX * this.currentViewport.zoom + this.currentViewport.x,
      y: canvasY * this.currentViewport.zoom + this.currentViewport.y,
    };
  }

  /**
   * Performs hit testing to find an object at the given canvas position.
   * Searches in reverse z-order (top-most first).
   * @param canvasX - X position in canvas units
   * @param canvasY - Y position in canvas units
   * @param objects - Array of objects to test against
   * @returns The topmost visible, unlocked object at the point, or null
   */
  public getObjectAtPoint(canvasX: number, canvasY: number, objects: DesignObject[]): DesignObject | null {
    // Search in reverse order (top-most first)
    for (let i = objects.length - 1; i >= 0; i--) {
      const obj = objects[i];
      if (!obj.visible || obj.locked) continue;

      // Simple bounding box hit test (doesn't account for rotation)
      if (
        canvasX >= obj.x &&
        canvasX <= obj.x + obj.width &&
        canvasY >= obj.y &&
        canvasY <= obj.y + obj.height
      ) {
        return obj;
      }
    }
    return null;
  }

  /**
   * Resizes the renderer to fit its container.
   * Should be called when the window or container size changes.
   */
  public resize(): void {
    if (this.isInitialized) {
      this.app.resize();
    }
  }

  /**
   * Cleans up all resources and destroys the PixiJS application.
   * Should be called when the component unmounts.
   */
  public destroy(): void {
    this.objectMap.forEach((container) => {
      container.destroy({ children: true });
    });
    this.objectMap.clear();
    this.app.destroy(true, { children: true });
  }
}
