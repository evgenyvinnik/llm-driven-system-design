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
  { base: '#F5DEB3', shadow: '#DEB887', highlight: '#FFF8DC' }, // Wheat
  { base: '#D2B48C', shadow: '#BC8F8F', highlight: '#F5DEB3' }, // Tan
  { base: '#FFDAB9', shadow: '#E6C9A8', highlight: '#FFF5EE' }, // Peach
  { base: '#8B7355', shadow: '#6B5344', highlight: '#A08060' }, // Brown
  { base: '#CD853F', shadow: '#A0522D', highlight: '#DEB887' }, // Peru
  { base: '#F4E4D0', shadow: '#E8D4B8', highlight: '#FFFAF0' }, // Cream
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
  { base: '#2C1810', highlight: '#4A3728' }, // Dark brown
  { base: '#8B4513', highlight: '#A0522D' }, // Saddle brown
  { base: '#FFD700', highlight: '#FFF8DC' }, // Golden
  { base: '#B87333', highlight: '#CD853F' }, // Copper
  { base: '#1C1C1C', highlight: '#383838' }, // Black
  { base: '#C0C0C0', highlight: '#E8E8E8' }, // Silver
  { base: '#8B0000', highlight: '#B22222' }, // Dark red
  { base: '#D2691E', highlight: '#E9967A' }, // Chocolate
];

/**
 * Available eye colors for avatar generation.
 * Covers common natural eye colors with varied tones.
 */
export const EYE_COLORS: string[] = [
  '#4169E1', // Royal blue
  '#228B22', // Forest green
  '#8B4513', // Saddle brown
  '#2F4F4F', // Dark slate
  '#6B8E23', // Olive
  '#4682B4', // Steel blue
  '#556B2F', // Dark olive
  '#8B7355', // Hazel
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
  { primary: '#8B0000', secondary: '#FFD700', accent: '#FFF8DC' }, // Royal red
  { primary: '#191970', secondary: '#C0C0C0', accent: '#B8860B' }, // Midnight blue
  { primary: '#2F4F4F', secondary: '#D4AF37', accent: '#F0E68C' }, // Dark slate
  { primary: '#4B0082', secondary: '#DDA0DD', accent: '#FFD700' }, // Indigo
  { primary: '#006400', secondary: '#DAA520', accent: '#FFFACD' }, // Dark green
  { primary: '#800020', secondary: '#FFE4E1', accent: '#C0C0C0' }, // Burgundy
  { primary: '#483D8B', secondary: '#E6E6FA', accent: '#B8860B' }, // Dark slate blue
  { primary: '#2E8B57', secondary: '#F0FFF0', accent: '#DAA520' }, // Sea green
];

/**
 * Metallic accessory colors for crowns, jewelry, and decorative elements.
 * Represents gold, silver, and bronze metal finishes.
 */
export const ACCESSORY_COLORS: string[] = [
  '#FFD700', // Gold
  '#C0C0C0', // Silver
  '#B8860B', // Dark gold
  '#CD853F', // Peru (bronze)
];
