import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { BuyButton } from '@/components/shop/BuyButton'
import { FALLBACK_PRODUCTS, fetchProducts, type Product } from '@/lib/products'

export const Route = createFileRoute('/product/$id')({ component: ProductPage })

function ProductPage() {
  const { id } = Route.useParams()
  const [products, setProducts] = useState<Product[]>(FALLBACK_PRODUCTS)
  useEffect(() => {
    void fetchProducts().then(setProducts)
  }, [])
  const product = products.find((p) => p.id === id)
  if (!product) return <p>Product not found. <Link to="/" className="underline">Back to the shop</Link></p>
  return (
    <div className="grid grid-cols-1 gap-8 md:grid-cols-2" data-page="product">
      <div className={`h-80 rounded-3xl bg-gradient-to-br ${product.tone}`} />
      <div className="space-y-4">
        <Link to="/" className="text-sm text-brand-700 hover:underline">
          ← All products
        </Link>
        <h1 className="font-display text-3xl font-bold">{product.name}</h1>
        <p className="text-2xl font-semibold tabular-nums">${product.price}</p>
        <p className="text-stone-600">{product.blurb}</p>
        <BuyButton product={product} />
        <p className="text-xs text-stone-500">In stock. Ships in 1–2 business days.</p>
      </div>
    </div>
  )
}
