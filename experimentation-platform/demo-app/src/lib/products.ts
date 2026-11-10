export interface Product {
  id: string
  name: string
  price: number
  tone: string
  blurb: string
}

/** Same catalog the shop API serves; used if the API is unreachable so the page still renders. */
export const FALLBACK_PRODUCTS: Product[] = [
  { id: 'kettle', name: 'Gooseneck Kettle', price: 89, tone: 'from-amber-200 to-orange-300', blurb: 'Precise pour, 0.9 L, holds temperature for an hour.' },
  { id: 'grinder', name: 'Burr Grinder', price: 149, tone: 'from-stone-200 to-stone-400', blurb: '40 grind settings, conical steel burrs.' },
  { id: 'dripper', name: 'Ceramic Dripper', price: 32, tone: 'from-sky-100 to-sky-300', blurb: 'Spiral ribs for an even draw-down.' },
  { id: 'beans', name: 'House Blend, 1 kg', price: 28, tone: 'from-yellow-700 to-amber-900', blurb: 'Chocolate, red apple, brown sugar.' },
  { id: 'scale', name: 'Brew Scale', price: 59, tone: 'from-zinc-200 to-zinc-400', blurb: '0.1 g resolution with a built-in timer.' },
  { id: 'mugs', name: 'Stoneware Mugs (2)', price: 36, tone: 'from-rose-100 to-rose-300', blurb: 'Hand-glazed, 350 ml.' },
]

export async function fetchProducts(): Promise<Product[]> {
  try {
    const res = await fetch('/api/v1/shop/products')
    if (!res.ok) return FALLBACK_PRODUCTS
    return ((await res.json()) as { products: Product[] }).products
  } catch {
    return FALLBACK_PRODUCTS
  }
}
