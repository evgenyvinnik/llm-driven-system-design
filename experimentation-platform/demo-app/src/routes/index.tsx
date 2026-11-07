import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ProductCard } from '@/components/shop/ProductCard'
import { FALLBACK_PRODUCTS, fetchProducts, type Product } from '@/lib/products'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const [products, setProducts] = useState<Product[]>(FALLBACK_PRODUCTS)
  useEffect(() => {
    void fetchProducts().then(setProducts)
  }, [])
  return (
    <div className="space-y-6">
      <section className="rounded-3xl bg-gradient-to-br from-brand-700 to-brand-900 px-8 py-10 text-brand-50">
        <h1 className="font-display text-4xl font-bold">Brew better at home</h1>
        <p className="mt-2 max-w-xl text-brand-100">Kettles, grinders and beans for slow mornings. Open a product to see the buy button experiment; the Rewards tab hides another one most visitors never see.</p>
      </section>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-label="Products">
        {products.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>
    </div>
  )
}
