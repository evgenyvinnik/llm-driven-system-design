import { Link } from '@tanstack/react-router'
import type { Product } from '@/lib/products'
import { useShop } from '@/stores/shop-store'

export function ProductCard({ product }: { product: Product }) {
  const add = useShop((s) => s.add)
  return (
    <article className="card overflow-hidden" data-product={product.id}>
      <Link to="/product/$id" params={{ id: product.id }}>
        <div className={`h-40 bg-gradient-to-br ${product.tone}`} />
      </Link>
      <div className="space-y-2 p-4">
        <div className="flex items-baseline justify-between">
          <Link to="/product/$id" params={{ id: product.id }} className="font-display text-lg font-semibold hover:underline">
            {product.name}
          </Link>
          <span className="font-semibold tabular-nums">${product.price}</span>
        </div>
        <p className="text-sm text-stone-600">{product.blurb}</p>
        <button type="button" className="btn-outline w-full" onClick={() => add({ id: product.id, name: product.name, price: product.price })}>
          Quick add
        </button>
      </div>
    </article>
  )
}
