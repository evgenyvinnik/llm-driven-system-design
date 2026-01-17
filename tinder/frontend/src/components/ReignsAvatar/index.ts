/**
 * @fileoverview Barrel exports for the ReignsAvatar component library.
 * Re-exports all sub-components, types, and utilities for easy importing.
 */

// Main component
export { default } from './ReignsAvatar';
export { default as ReignsAvatar } from './ReignsAvatar';

// Types
export type {
  Gender,
  HairStyle,
  FaceShape,
  AvatarFeatures,
  AvatarRenderContext,
} from './types';

// Constants
export type { SkinPalette, HairColorPalette, ClothingPalette } from './constants';
export {
  SKIN_PALETTES,
  HAIR_COLORS,
  EYE_COLORS,
  CLOTHING_PALETTES,
  ACCESSORY_COLORS,
} from './constants';

// Utilities
export { seededRandom, generateFeatures, getFaceShape } from './utils';

// Sub-components (for advanced customization)
export { AvatarDefs } from './AvatarDefs';
export { BackHair, TopHair } from './Hair';
export { Neck, FaceShape as FaceShapeComponent, Cheekbones, Beard } from './Face';
export { Eyebrows, Eyes, Nose, Lips } from './FacialFeatures';
export { Crown, Earrings, Necklace } from './Accessories';
export { Clothing, Frame, Background } from './Clothing';
