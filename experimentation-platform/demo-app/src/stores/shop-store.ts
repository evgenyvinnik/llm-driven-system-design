import { create } from 'zustand'

export interface Shopper {
  id: string
  username: string
  displayName: string
  country: string | null
  plan: string | null
  orgId: string | null
}

interface CartLine {
  id: string
  name: string
  price: number
  qty: number
}

interface ShopState {
  user: Shopper | null
  cart: CartLine[]
  setUser: (user: Shopper | null) => void
  add: (line: Omit<CartLine, 'qty'>) => void
  clear: () => void
}

const CART_KEY = 'shop:cart'

function loadCart(): CartLine[] {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY) ?? '[]') as CartLine[]
  } catch {
    return []
  }
}

function saveCart(cart: CartLine[]): CartLine[] {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart))
  } catch {
    // ignore
  }
  return cart
}

export const useShop = create<ShopState>((set) => ({
  user: null,
  cart: loadCart(),
  setUser: (user) => set({ user }),
  add: (line) =>
    set((s) => {
      const existing = s.cart.find((l) => l.id === line.id)
      const cart = existing ? s.cart.map((l) => (l.id === line.id ? { ...l, qty: l.qty + 1 } : l)) : [...s.cart, { ...line, qty: 1 }]
      return { cart: saveCart(cart) }
    }),
  clear: () => set({ cart: saveCart([]) }),
}))
