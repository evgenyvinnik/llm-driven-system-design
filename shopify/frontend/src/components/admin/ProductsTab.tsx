import { useEffect, useState } from 'react';
import { productsApi } from '../../services/api';
import { Product } from '../../types';
import { ContentLoadingSpinner } from '../common';

/**
 * Product form data interface.
 */
interface ProductFormData {
  title: string;
  description: string;
  status: 'draft' | 'active';
  price: string;
  inventory: string;
}

/**
 * Initial empty form data.
 */
const emptyFormData: ProductFormData = {
  title: '',
  description: '',
  status: 'draft',
  price: '',
  inventory: '',
};

/**
 * Props for ProductsTab component.
 */
interface ProductsTabProps {
  /** Store ID to load products for */
  storeId: number;
}

/**
 * Products tab component.
 * Displays product list with add/edit/delete functionality.
 *
 * @param props - Products tab configuration
 * @returns Products management interface
 */
export function ProductsTab({ storeId }: ProductsTabProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [formData, setFormData] = useState<ProductFormData>(emptyFormData);

  useEffect(() => {
    loadProducts();
  }, [storeId]);

  /**
   * Loads products from the API.
   */
  const loadProducts = async () => {
    try {
      const { products } = await productsApi.list(storeId);
      setProducts(products);
    } catch (error) {
      console.error('Failed to load products:', error);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Handles form submission for creating or updating a product.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingProduct) {
        await productsApi.update(storeId, editingProduct.id, {
          title: formData.title,
          description: formData.description,
          status: formData.status,
        });
      } else {
        await productsApi.create(storeId, {
          title: formData.title,
          description: formData.description,
          status: formData.status,
          variants: [{
            title: 'Default',
            price: parseFloat(formData.price) || 0,
            inventory_quantity: parseInt(formData.inventory) || 0,
          }],
        });
      }
      closeModal();
      loadProducts();
    } catch (error) {
      console.error('Failed to save product:', error);
    }
  };

  /**
   * Handles product deletion.
   */
  const handleDelete = async (productId: number) => {
    if (!confirm('Are you sure you want to delete this product?')) return;
    try {
      await productsApi.delete(storeId, productId);
      loadProducts();
    } catch (error) {
      console.error('Failed to delete product:', error);
    }
  };

  /**
   * Opens the edit modal for a product.
   */
  const openEditModal = (product: Product) => {
    setEditingProduct(product);
    setFormData({
      title: product.title,
      description: product.description || '',
      status: product.status,
      price: product.variants?.[0]?.price?.toString() || '',
      inventory: product.variants?.[0]?.inventory_quantity?.toString() || '',
    });
    setShowModal(true);
  };

  /**
   * Opens the add product modal.
   */
  const openAddModal = () => {
    setEditingProduct(null);
    setFormData(emptyFormData);
    setShowModal(true);
  };

  /**
   * Closes the modal and resets form state.
   */
  const closeModal = () => {
    setShowModal(false);
    setEditingProduct(null);
    setFormData(emptyFormData);
  };

  if (loading) {
    return <ContentLoadingSpinner />;
  }

  return (
    <div className="space-y-6">
      <ProductsHeader productCount={products.length} onAddProduct={openAddModal} />

      {products.length === 0 ? (
        <EmptyProductsState />
      ) : (
        <ProductsTable
          products={products}
          onEdit={openEditModal}
          onDelete={handleDelete}
        />
      )}

      {showModal && (
        <ProductModal
          isEditing={!!editingProduct}
          formData={formData}
          setFormData={setFormData}
          onSubmit={handleSubmit}
          onClose={closeModal}
        />
      )}
    </div>
  );
}

/**
 * Products header with count and add button.
 */
interface ProductsHeaderProps {
  productCount: number;
  onAddProduct: () => void;
}

function ProductsHeader({ productCount, onAddProduct }: ProductsHeaderProps) {
  return (
    <div className="flex justify-between items-center">
      <h2 className="text-lg font-medium text-gray-900">{productCount} products</h2>
      <button
        onClick={onAddProduct}
        className="bg-indigo-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-indigo-700 transition-colors"
      >
        Add Product
      </button>
    </div>
  );
}

/**
 * Empty state when no products exist.
 */
function EmptyProductsState() {
  return (
    <div className="bg-white rounded-xl shadow-sm p-12 text-center">
      <p className="text-gray-500">No products yet. Add your first product to get started.</p>
    </div>
  );
}

/**
 * Products table component.
 */
interface ProductsTableProps {
  products: Product[];
  onEdit: (product: Product) => void;
  onDelete: (productId: number) => void;
}

function ProductsTable({ products, onEdit, onDelete }: ProductsTableProps) {
  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden">
      <table className="w-full">
        <thead className="bg-gray-50">
          <tr>
            <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">Product</th>
            <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">Status</th>
            <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">Price</th>
            <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">Inventory</th>
            <th className="text-right px-6 py-3 text-sm font-medium text-gray-500">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {products.map((product) => (
            <ProductRow
              key={product.id}
              product={product}
              onEdit={() => onEdit(product)}
              onDelete={() => onDelete(product.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Individual product row component.
 */
interface ProductRowProps {
  product: Product;
  onEdit: () => void;
  onDelete: () => void;
}

function ProductRow({ product, onEdit, onDelete }: ProductRowProps) {
  const totalInventory = product.variants?.reduce((sum, v) => sum + (v.inventory_quantity || 0), 0) || 0;

  return (
    <tr className="hover:bg-gray-50">
      <td className="px-6 py-4">
        <div className="font-medium text-gray-900">{product.title}</div>
        <div className="text-sm text-gray-500">{product.handle}</div>
      </td>
      <td className="px-6 py-4">
        <StatusBadge status={product.status} />
      </td>
      <td className="px-6 py-4 text-gray-600">
        ${product.variants?.[0]?.price || 0}
      </td>
      <td className="px-6 py-4 text-gray-600">
        {totalInventory}
      </td>
      <td className="px-6 py-4 text-right">
        <button onClick={onEdit} className="text-indigo-600 hover:text-indigo-800 mr-4">
          Edit
        </button>
        <button onClick={onDelete} className="text-red-600 hover:text-red-800">
          Delete
        </button>
      </td>
    </tr>
  );
}

/**
 * Status badge component.
 */
interface StatusBadgeProps {
  status: Product['status'];
}

function StatusBadge({ status }: StatusBadgeProps) {
  const colorClass =
    status === 'active' ? 'bg-green-100 text-green-700' :
    status === 'draft' ? 'bg-yellow-100 text-yellow-700' :
    'bg-gray-100 text-gray-700';

  return (
    <span className={`text-xs px-2 py-1 rounded-full ${colorClass}`}>
      {status}
    </span>
  );
}

/**
 * Product add/edit modal component.
 */
interface ProductModalProps {
  isEditing: boolean;
  formData: ProductFormData;
  setFormData: (data: ProductFormData) => void;
  onSubmit: (e: React.FormEvent) => void;
  onClose: () => void;
}

function ProductModal({ isEditing, formData, setFormData, onSubmit, onClose }: ProductModalProps) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6">
        <h3 className="text-xl font-semibold text-gray-900 mb-6">
          {isEditing ? 'Edit Product' : 'Add Product'}
        </h3>
        <form onSubmit={onSubmit} className="space-y-4">
          <FormField
            label="Title"
            type="text"
            value={formData.title}
            onChange={(v) => setFormData({ ...formData, title: v })}
            required
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              rows={3}
            />
          </div>
          {!isEditing && (
            <>
              <FormField
                label="Price"
                type="number"
                step="0.01"
                value={formData.price}
                onChange={(v) => setFormData({ ...formData, price: v })}
              />
              <FormField
                label="Inventory"
                type="number"
                value={formData.inventory}
                onChange={(v) => setFormData({ ...formData, inventory: v })}
              />
            </>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <select
              value={formData.status}
              onChange={(e) => setFormData({ ...formData, status: e.target.value as 'draft' | 'active' })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
            >
              <option value="draft">Draft</option>
              <option value="active">Active</option>
            </select>
          </div>
          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 px-4 border border-gray-300 rounded-lg font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 py-2 px-4 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700"
            >
              {isEditing ? 'Save Changes' : 'Add Product'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Reusable form field component.
 */
interface FormFieldProps {
  label: string;
  type?: string;
  step?: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}

function FormField({ label, type = 'text', step, value, onChange, required }: FormFieldProps) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type={type}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
        required={required}
      />
    </div>
  );
}
