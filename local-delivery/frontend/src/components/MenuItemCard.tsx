import type { MenuItem } from '@/types';
import { useCartStore } from '@/stores/cartStore';

interface MenuItemCardProps {
  item: MenuItem;
}

export function MenuItemCard({ item }: MenuItemCardProps) {
  const { addItem, items, updateQuantity } = useCartStore();

  const cartItem = items.find((i) => i.menuItem.id === item.id);
  const quantity = cartItem?.quantity || 0;

  const handleAdd = () => {
    addItem(item, 1);
  };

  const handleIncrement = () => {
    updateQuantity(item.id, quantity + 1);
  };

  const handleDecrement = () => {
    updateQuantity(item.id, quantity - 1);
  };

  return (
    <div className="card p-4">
      <div className="flex justify-between">
        <div className="flex-1">
          <h4 className="font-medium text-gray-900">{item.name}</h4>
          {item.description && (
            <p className="text-sm text-gray-500 mt-1">{item.description}</p>
          )}
          <p className="font-semibold text-primary-600 mt-2">
            ${item.price.toFixed(2)}
          </p>
        </div>

        <div className="ml-4">
          {!item.is_available ? (
            <span className="text-sm text-gray-400">Unavailable</span>
          ) : quantity === 0 ? (
            <button
              onClick={handleAdd}
              className="btn-primary btn-sm"
            >
              Add
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={handleDecrement}
                className="w-8 h-8 rounded-full bg-gray-200 hover:bg-gray-300 flex items-center justify-center"
              >
                -
              </button>
              <span className="w-8 text-center font-medium">{quantity}</span>
              <button
                onClick={handleIncrement}
                className="w-8 h-8 rounded-full bg-primary-600 hover:bg-primary-700 text-white flex items-center justify-center"
              >
                +
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
