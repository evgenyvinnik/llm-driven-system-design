import { Link } from '@tanstack/react-router'
import { useVariant } from 'experimentation-sdk/react'
import { CartIcon, CoffeeIcon, GiftIcon, SearchIcon, UserIcon } from '@/components/icons'
import { useShop } from '@/stores/shop-store'

/** The `new_search` flag swaps the header search for the typeahead version (flags log no exposures). */
export function Header() {
  const user = useShop((s) => s.user)
  const count = useShop((s) => s.cart.reduce((n, l) => n + l.qty, 0))
  const search = useVariant('new_search')
  const link = 'rounded-full px-3 py-1.5 text-sm font-medium text-brand-900/80 hover:bg-brand-100'
  return (
    <header className="sticky top-0 z-10 border-b border-brand-100 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
        <Link to="/" className="flex items-center gap-2 font-display text-xl font-bold text-brand-700">
          <CoffeeIcon className="h-6 w-6" /> Copper Kettle
        </Link>
        <div
          className={`flex flex-1 items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${search.variant === 'on' ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-stone-200 text-stone-400'}`}
          data-flag-new-search={search.variant ?? 'none'}
        >
          <SearchIcon />
          {search.variant === 'on' ? 'Search kettles, grinders, beans… (new typeahead)' : 'Search'}
        </div>
        <nav className="flex items-center gap-1">
          <Link to="/" className={link} activeOptions={{ exact: true }} activeProps={{ className: `${link} bg-brand-100` }}>
            Shop
          </Link>
          <Link to="/rewards" className={link} activeProps={{ className: `${link} bg-brand-100` }}>
            <span className="inline-flex items-center gap-1">
              <GiftIcon className="h-3.5 w-3.5" /> Rewards
            </span>
          </Link>
          <Link to="/cart" className={link} activeProps={{ className: `${link} bg-brand-100` }}>
            <span className="inline-flex items-center gap-1">
              <CartIcon /> Cart{count > 0 && <span className="num rounded-full bg-brand-600 px-1.5 text-[11px] text-white">{count}</span>}
            </span>
          </Link>
          <Link to="/signin" className={link}>
            <span className="inline-flex items-center gap-1">
              <UserIcon /> {user ? user.displayName.split(' ')[0] : 'Sign in'}
            </span>
          </Link>
        </nav>
      </div>
    </header>
  )
}
