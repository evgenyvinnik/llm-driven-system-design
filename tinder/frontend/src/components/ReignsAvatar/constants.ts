/**
 * @fileoverview Constants and color palettes for the ReignsAvatar procedural avatar generator.
 * Contains skin tones, hair colors, eye colors, clothing palettes, and accessory colors
 * inspired by the Reigns: Her Majesty art style.
 */

/**
 * Skin color palette with base color, shadow tone, and highlight accent.
 * Provides realistic skin tone variations for diverse avatar generation.
 */
export interface SkinPalette {
  /** Primary skin tone color */
  base: string;
  /** Darker shade for shadows and depth */
  shadow: string;
  /** Lighter shade for highlights and accents */
  highlight: string;
}

/**
 * Available skin color palettes covering diverse skin tones.
 * Each palette includes base, shadow, and highlight colors for realistic rendering.
 */
export const SKIN_PALETTES: SkinPalette[] = [
  { base: '#E7D3C0', shadow: '#CBB7A3', highlight: '#F4E7D9' }, // Porcelain
  { base: '#D9C1A6', shadow: '#B79F86', highlight: '#EAD9C5' }, // Warm beige
  { base: '#C7A98E', shadow: '#A3866D', highlight: '#D9C2AE' }, // Honey
  { base: '#9F7F65', shadow: '#7D624E', highlight: '#B4947A' }, // Umber
  { base: '#F0E2D5', shadow: '#D7C8BA', highlight: '#FAF3EB' }, // Almond
];

/**
 * Hair color palette with base color and highlight for depth.
 */
export interface HairColorPalette {
  /** Primary hair color */
  base: string;
  /** Lighter shade for hair highlights */
  highlight: string;
}

/**
 * Available hair color palettes covering natural and stylized hair colors.
 * Each palette includes base and highlight colors for gradient effects.
 */
export const HAIR_COLORS: HairColorPalette[] = [
  { base: '#2B1E16', highlight: '#3D2D23' }, // Espresso
  { base: '#503626', highlight: '#6B4A35' }, // Chestnut
  { base: '#7A5A3B', highlight: '#8E6A4A' }, // Hazel
  { base: '#6A4A3A', highlight: '#7D5B4A' }, // Mocha
  { base: '#A07A5A', highlight: '#B08D6C' }, // Soft auburn
  { base: '#1F1F1F', highlight: '#353535' }, // Charcoal
  { base: '#C2B8A3', highlight: '#D6CDBC' }, // Ash
];

/**
 * Available eye colors for avatar generation.
 * Covers common natural eye colors with varied tones.
 */
export const EYE_COLORS: string[] = [
  '#3F3A32', // Umber
  '#5B6B5B', // Sage
  '#6C7A89', // Slate
  '#4F6A8C', // Dusty blue
  '#7A6350', // Hazel
  '#2F2E2B', // Charcoal
  '#7B6A58', // Taupe
];

/**
 * Clothing color palette with primary, secondary, and accent colors.
 * Medieval-inspired color combinations for royal attire.
 */
export interface ClothingPalette {
  /** Main clothing color */
  primary: string;
  /** Secondary/complementary color */
  secondary: string;
  /** Accent color for details */
  accent: string;
}

/**
 * Medieval-inspired clothing color palettes for avatar outfits.
 * Each palette creates a cohesive royal aesthetic.
 */
export const CLOTHING_PALETTES: ClothingPalette[] = [
  { primary: '#4B4A57', secondary: '#B7B0A3', accent: '#D8D1C6' }, // Stone plum
  { primary: '#2F3B45', secondary: '#A9AFAE', accent: '#D2D7D6' }, // Slate navy
  { primary: '#4A3A2F', secondary: '#C2B4A2', accent: '#E3D7C7' }, // Warm taupe
  { primary: '#3E4B3E', secondary: '#B9C1B2', accent: '#DDE5D8' }, // Moss
  { primary: '#5A3E45', secondary: '#CBB6B7', accent: '#E8DADA' }, // Dusty rose
];

/**
 * Metallic accessory colors for crowns, jewelry, and decorative elements.
 * Represents gold, silver, and bronze metal finishes.
 */
export const ACCESSORY_COLORS: string[] = [
  '#C7B48A', // Soft gold
  '#AFA79A', // Brushed silver
  '#8F7C5E', // Antique bronze
  '#B18C3E', // Dark gold
];
