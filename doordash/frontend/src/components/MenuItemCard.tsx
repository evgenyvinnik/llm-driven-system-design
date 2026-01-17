import type { MenuItem } from '../types';
import { useCartStore } from '../stores/cartStore';

interface Props {
  item: MenuItem;
  restaurantId: number;
}

export function MenuItemCard({ item }: Props) {
  const addItem = useCartStore((s) => s.addItem);
  const items = useCartStore((s) => s.items);
  const updateQuantity = useCartStore((s) => s.updateQuantity);

  const cartItem = items.find((i) => i.menuItem.id === item.id);
  const quantity = cartItem?.quantity || 0;

  return (
    <div className="bg-white rounded-lg p-4 flex gap-4 hover:shadow-sm transition">
      <div className="flex-1">
        <h4 className="font-medium text-gray-900">{item.name}</h4>
        {item.description && (
          <p className="text-sm text-gray-500 mt-1 line-clamp-2">{item.description}</p>
        )}
        <p className="font-medium text-gray-900 mt-2">${Number(item.price).toFixed(2)}</p>
      </div>
      <div className="flex flex-col items-center justify-center">
        {quantity > 0 ? (
          <div className="flex items-center gap-2">
            <button
              onClick={() => updateQuantity(item.id, quantity - 1)}
              className="w-8 h-8 rounded-full border border-gray-300 flex items-center justify-center hover:bg-gray-50"
            >
              -
            </button>
            <span className="font-medium w-6 text-center">{quantity}</span>
            <button
              onClick={() => updateQuantity(item.id, quantity + 1)}
              className="w-8 h-8 rounded-full border border-gray-300 flex items-center justify-center hover:bg-gray-50"
            >
              +
            </button>
          </div>
        ) : (
          <button
            onClick={() => addItem(item)}
            disabled={!item.is_available}
            className="bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-full font-medium hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add
          </button>
        )}
      </div>
    </div>
  );
}
