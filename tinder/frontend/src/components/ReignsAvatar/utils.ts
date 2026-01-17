/**
 * @fileoverview Utility functions for the ReignsAvatar procedural avatar generator.
 * Contains seeded random number generation and feature generation logic.
 */

import {
  SKIN_PALETTES,
  HAIR_COLORS,
  EYE_COLORS,
  CLOTHING_PALETTES,
  ACCESSORY_COLORS,
} from './constants';
import type { AvatarFeatures, Gender, HairStyle, FaceShape } from './types';

/**
 * Creates a seeded random number generator for deterministic results.
 * Uses a simple hash function to convert a string seed into a numeric state,
 * then generates pseudo-random numbers using a sine-based algorithm.
 *
 * @param seed - String to seed the generator
 * @returns Function that returns the next random number (0-1) in the sequence
 *
 * @example
 * const random = seededRandom('user-123');
 * const value1 = random(); // Always same for 'user-123'
 * const value2 = random(); // Next in deterministic sequence
 */
export function seededRandom(seed: string): () => number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }

  return function () {
    hash = Math.sin(hash) * 10000;
    return hash - Math.floor(hash);
  };
}

/**
 * Generates a complete set of avatar features from a seed string.
 * All features are deterministically derived from the seed, ensuring
 * the same seed always produces the same avatar appearance.
 *
 * @param seed - Seed string for deterministic generation
 * @returns Complete avatar feature set including colors, styles, and attributes
 *
 * @example
 * const features = generateFeatures('john-doe-123');
 * // features.gender, features.hairStyle, etc. are deterministic
 */
export function generateFeatures(seed: string): AvatarFeatures {
  const random = seededRandom(seed);

  const gender: Gender = random() > 0.5 ? 'feminine' : 'masculine';

  // Hair style options differ by gender
  const hairStyles: HairStyle[] =
    gender === 'feminine'
      ? ['medium', 'long', 'wavy', 'braided']
      : ['short', 'medium', 'bald', 'wavy'];

  const faceShapes: FaceShape[] = ['oval', 'round', 'angular', 'square'];

  return {
    gender,
    skinPalette: SKIN_PALETTES[Math.floor(random() * SKIN_PALETTES.length)],
    hairColor: HAIR_COLORS[Math.floor(random() * HAIR_COLORS.length)],
    hairStyle: hairStyles[Math.floor(random() * hairStyles.length)],
    eyeColor: EYE_COLORS[Math.floor(random() * EYE_COLORS.length)],
    clothingPalette: CLOTHING_PALETTES[Math.floor(random() * CLOTHING_PALETTES.length)],
    accessoryColor: ACCESSORY_COLORS[Math.floor(random() * ACCESSORY_COLORS.length)],
    faceShape: faceShapes[Math.floor(random() * faceShapes.length)],
    hasBeard: gender === 'masculine' && random() > 0.6,
    hasCrown: random() > 0.7,
    hasNecklace: random() > 0.5,
    hasEarrings: gender === 'feminine' && random() > 0.4,
    eyeSize: 0.8 + random() * 0.4,
    noseSize: 0.8 + random() * 0.4,
    lipSize: 0.8 + random() * 0.4,
    browThickness: 0.6 + random() * 0.6,
    cheekbones: random(),
  };
}

/**
 * Generates SVG path data for different face shapes.
 * Creates smooth curves that define the face outline for the avatar.
 *
 * @param shape - The type of face shape to generate
 * @param centerX - X coordinate of the face center
 * @param centerY - Y coordinate of the face center
 * @param width - Width of the face
 * @param height - Height of the face
 * @returns SVG path data string for the face outline
 *
 * @example
 * const pathData = getFaceShape('oval', 200, 200, 140, 180);
 * // Returns SVG path string for an oval face centered at (200, 200)
 */
export function getFaceShape(
  shape: FaceShape,
  centerX: number,
  centerY: number,
  width: number,
  height: number
): string {
  switch (shape) {
    case 'oval':
      return `M ${centerX} ${centerY - height / 2}
              C ${centerX + width / 2} ${centerY - height / 2}
                ${centerX + width / 2} ${centerY + height / 3}
                ${centerX} ${centerY + height / 2}
              C ${centerX - width / 2} ${centerY + height / 3}
                ${centerX - width / 2} ${centerY - height / 2}
                ${centerX} ${centerY - height / 2} Z`;
    case 'round':
      return `M ${centerX} ${centerY - height / 2}
              C ${centerX + (width / 2) * 1.1} ${centerY - height / 3}
                ${centerX + (width / 2) * 1.1} ${centerY + height / 3}
                ${centerX} ${centerY + height / 2}
              C ${centerX - (width / 2) * 1.1} ${centerY + height / 3}
                ${centerX - (width / 2) * 1.1} ${centerY - height / 3}
                ${centerX} ${centerY - height / 2} Z`;
    case 'angular':
      return `M ${centerX} ${centerY - height / 2}
              L ${centerX + width / 2} ${centerY - height / 4}
              L ${centerX + width / 3} ${centerY + height / 3}
              L ${centerX} ${centerY + height / 2}
              L ${centerX - width / 3} ${centerY + height / 3}
              L ${centerX - width / 2} ${centerY - height / 4} Z`;
    case 'square':
      return `M ${centerX} ${centerY - height / 2}
              C ${centerX + width / 2} ${centerY - height / 2}
                ${centerX + width / 2} ${centerY + height / 4}
                ${centerX + width / 3} ${centerY + height / 2}
              L ${centerX - width / 3} ${centerY + height / 2}
              C ${centerX - width / 2} ${centerY + height / 4}
                ${centerX - width / 2} ${centerY - height / 2}
                ${centerX} ${centerY - height / 2} Z`;
    default:
      return getFaceShape('oval', centerX, centerY, width, height);
  }
}
