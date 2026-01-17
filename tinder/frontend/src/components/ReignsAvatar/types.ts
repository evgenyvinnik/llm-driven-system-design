/**
 * @fileoverview Type definitions for the ReignsAvatar procedural avatar generator.
 * Defines all interfaces and type aliases used across avatar sub-components.
 */

import type { SkinPalette, HairColorPalette, ClothingPalette } from './constants';

/**
 * Gender presentation for avatar appearance.
 * Affects hair style options, makeup, and accessory choices.
 */
export type Gender = 'masculine' | 'feminine';

/**
 * Available hair styles for avatar generation.
 * Different styles are available based on gender.
 */
export type HairStyle = 'short' | 'medium' | 'long' | 'bald' | 'wavy' | 'braided';

/**
 * Face shape options that determine facial outline geometry.
 * Each shape creates a distinct facial silhouette.
 */
export type FaceShape = 'oval' | 'round' | 'angular' | 'square';

/**
 * Complete set of features that define an avatar's appearance.
 * Generated deterministically from a seed string.
 */
export interface AvatarFeatures {
  /** Gender presentation affecting style options */
  gender: Gender;
  /** Skin color palette for face and neck */
  skinPalette: SkinPalette;
  /** Hair color palette for all hair elements */
  hairColor: HairColorPalette;
  /** Style of hair rendering */
  hairStyle: HairStyle;
  /** Eye iris color */
  eyeColor: string;
  /** Clothing color palette for outfit */
  clothingPalette: ClothingPalette;
  /** Metallic color for accessories */
  accessoryColor: string;
  /** Shape of the face outline */
  faceShape: FaceShape;
  /** Whether to render a beard (masculine only) */
  hasBeard: boolean;
  /** Whether to render a crown */
  hasCrown: boolean;
  /** Whether to render a necklace */
  hasNecklace: boolean;
  /** Whether to render earrings (feminine only) */
  hasEarrings: boolean;
  /** Eye size multiplier (0.8-1.2) */
  eyeSize: number;
  /** Nose size multiplier (0.8-1.2) */
  noseSize: number;
  /** Lip size multiplier (0.8-1.2) */
  lipSize: number;
  /** Eyebrow thickness multiplier (0.6-1.2) */
  browThickness: number;
  /** Cheekbone prominence (0-1) */
  cheekbones: number;
}

/**
 * Render context passed to all avatar sub-components.
 * Contains positioning and sizing information for consistent rendering.
 */
export interface AvatarRenderContext {
  /** Avatar features determining appearance */
  features: AvatarFeatures;
  /** Unique seed string for deterministic generation */
  seed: string;
  /** Total size of the avatar in pixels */
  size: number;
  /** Center X coordinate */
  cx: number;
  /** Center Y coordinate */
  cy: number;
  /** Face width in pixels */
  faceWidth: number;
  /** Face height in pixels */
  faceHeight: number;
}
