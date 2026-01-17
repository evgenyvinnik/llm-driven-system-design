export function Footer() {
  return (
    <footer className="bg-secondary-900 text-white mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          <div>
            <h3 className="text-lg font-display font-bold mb-4">Handmade</h3>
            <p className="text-secondary-300 text-sm">
              A marketplace for unique, handcrafted, and vintage items from
              talented sellers around the world.
            </p>
          </div>

          <div>
            <h4 className="font-semibold mb-4">Shop</h4>
            <ul className="space-y-2 text-sm text-secondary-300">
              <li>
                <a href="/category/jewelry-accessories" className="hover:text-white">
                  Jewelry & Accessories
                </a>
              </li>
              <li>
                <a href="/category/home-living" className="hover:text-white">
                  Home & Living
                </a>
              </li>
              <li>
                <a href="/category/vintage" className="hover:text-white">
                  Vintage
                </a>
              </li>
              <li>
                <a href="/category/art-collectibles" className="hover:text-white">
                  Art & Collectibles
                </a>
              </li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold mb-4">Sell</h4>
            <ul className="space-y-2 text-sm text-secondary-300">
              <li>
                <a href="/seller/create-shop" className="hover:text-white">
                  Open a Shop
                </a>
              </li>
              <li>
                <a href="/seller/dashboard" className="hover:text-white">
                  Seller Dashboard
                </a>
              </li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold mb-4">About</h4>
            <ul className="space-y-2 text-sm text-secondary-300">
              <li>
                <a href="#" className="hover:text-white">
                  About Us
                </a>
              </li>
              <li>
                <a href="#" className="hover:text-white">
                  Privacy Policy
                </a>
              </li>
              <li>
                <a href="#" className="hover:text-white">
                  Terms of Service
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="border-t border-secondary-800 mt-8 pt-8 text-center text-sm text-secondary-400">
          <p>This is an educational project demonstrating marketplace architecture.</p>
        </div>
      </div>
    </footer>
  );
}
