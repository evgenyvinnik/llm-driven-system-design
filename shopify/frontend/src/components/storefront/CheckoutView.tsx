import { Cart, CartLineItem } from '../../types';
import { BackArrowIcon } from '../icons';

/**
 * Checkout data interface for shipping information form.
 */
export interface CheckoutFormData {
  email: string;
  firstName: string;
  lastName: string;
  address1: string;
  city: string;
  province: string;
  country: string;
  zip: string;
}

/**
 * Props for CheckoutView component.
 */
interface CheckoutViewProps {
  /** Cart data for order summary */
  cart: Cart | null;
  /** Current checkout form data */
  checkoutData: CheckoutFormData;
  /** Callback to update form data */
  setCheckoutData: (data: CheckoutFormData) => void;
  /** Form submission handler */
  onSubmit: (e: React.FormEvent) => void;
  /** Whether payment is being processed */
  processing: boolean;
  /** Callback to go back to cart */
  onBack: () => void;
  /** Primary theme color */
  primaryColor: string;
}

/**
 * Checkout view component.
 * Displays shipping form and order summary with payment submission.
 *
 * @param props - Checkout view configuration
 * @returns Two-column layout with shipping form and order summary
 */
export function CheckoutView({
  cart,
  checkoutData,
  setCheckoutData,
  onSubmit,
  processing,
  onBack,
  primaryColor,
}: CheckoutViewProps) {
  const subtotal = cart?.subtotal || 0;
  const shipping = 0; // Free shipping
  const tax = subtotal * 0.1; // 10% tax
  const total = subtotal + shipping + tax;

  return (
    <div className="max-w-4xl mx-auto">
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-6"
      >
        <BackArrowIcon />
        Back to cart
      </button>

      <h1 className="text-3xl font-bold text-gray-900 mb-8">Checkout</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <ShippingForm
          checkoutData={checkoutData}
          setCheckoutData={setCheckoutData}
          onSubmit={onSubmit}
          processing={processing}
          total={total}
          primaryColor={primaryColor}
        />

        <OrderSummary
          lineItems={cart?.line_items || []}
          subtotal={subtotal}
          shipping={shipping}
          tax={tax}
          total={total}
        />
      </div>
    </div>
  );
}

/**
 * Shipping information form component.
 */
interface ShippingFormProps {
  checkoutData: CheckoutFormData;
  setCheckoutData: (data: CheckoutFormData) => void;
  onSubmit: (e: React.FormEvent) => void;
  processing: boolean;
  total: number;
  primaryColor: string;
}

function ShippingForm({
  checkoutData,
  setCheckoutData,
  onSubmit,
  processing,
  total,
  primaryColor,
}: ShippingFormProps) {
  /**
   * Updates a single field in the checkout form data.
   */
  const updateField = (field: keyof CheckoutFormData, value: string) => {
    setCheckoutData({ ...checkoutData, [field]: value });
  };

  return (
    <div className="bg-white rounded-xl shadow-sm p-6">
      <h2 className="text-xl font-semibold text-gray-900 mb-6">Shipping Information</h2>
      <form onSubmit={onSubmit} className="space-y-4">
        <FormInput
          label="Email"
          type="email"
          value={checkoutData.email}
          onChange={(v) => updateField('email', v)}
          required
        />
        <div className="grid grid-cols-2 gap-4">
          <FormInput
            label="First Name"
            value={checkoutData.firstName}
            onChange={(v) => updateField('firstName', v)}
            required
          />
          <FormInput
            label="Last Name"
            value={checkoutData.lastName}
            onChange={(v) => updateField('lastName', v)}
            required
          />
        </div>
        <FormInput
          label="Address"
          value={checkoutData.address1}
          onChange={(v) => updateField('address1', v)}
          required
        />
        <div className="grid grid-cols-2 gap-4">
          <FormInput
            label="City"
            value={checkoutData.city}
            onChange={(v) => updateField('city', v)}
            required
          />
          <FormInput
            label="State/Province"
            value={checkoutData.province}
            onChange={(v) => updateField('province', v)}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Country</label>
            <select
              value={checkoutData.country}
              onChange={(e) => updateField('country', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
            >
              <option value="US">United States</option>
              <option value="CA">Canada</option>
              <option value="GB">United Kingdom</option>
            </select>
          </div>
          <FormInput
            label="ZIP Code"
            value={checkoutData.zip}
            onChange={(v) => updateField('zip', v)}
            required
          />
        </div>

        <button
          type="submit"
          disabled={processing}
          className="w-full py-3 rounded-lg font-medium text-white text-lg mt-6 disabled:opacity-50"
          style={{ backgroundColor: primaryColor }}
        >
          {processing ? 'Processing...' : `Pay $${total.toFixed(2)}`}
        </button>
      </form>
    </div>
  );
}

/**
 * Reusable form input component.
 */
interface FormInputProps {
  label: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}

function FormInput({ label, type = 'text', value, onChange, required }: FormInputProps) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
        required={required}
      />
    </div>
  );
}

/**
 * Order summary component showing line items and totals.
 */
interface OrderSummaryProps {
  lineItems: CartLineItem[];
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
}

function OrderSummary({ lineItems, subtotal, shipping, tax, total }: OrderSummaryProps) {
  return (
    <div className="bg-white rounded-xl shadow-sm p-6 h-fit">
      <h2 className="text-xl font-semibold text-gray-900 mb-6">Order Summary</h2>
      <div className="space-y-3 mb-6">
        {lineItems.map((item: CartLineItem) => (
          <div key={item.variant_id} className="flex justify-between text-sm">
            <span className="text-gray-600">{item.product_title} x {item.quantity}</span>
            <span>${(item.price * item.quantity).toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div className="border-t pt-4 space-y-2">
        <SummaryRow label="Subtotal" value={`$${subtotal.toFixed(2)}`} />
        <SummaryRow label="Shipping" value={shipping === 0 ? 'Free' : `$${shipping.toFixed(2)}`} />
        <SummaryRow label="Tax" value={`$${tax.toFixed(2)}`} />
        <div className="flex justify-between font-bold text-lg pt-2 border-t">
          <span>Total</span>
          <span>${total.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Summary row component for displaying label-value pairs.
 */
interface SummaryRowProps {
  label: string;
  value: string;
}

function SummaryRow({ label, value }: SummaryRowProps) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-600">{label}</span>
      <span>{value}</span>
    </div>
  );
}
