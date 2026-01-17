interface CardDisplayProps {
  brand: string;
  last4: string;
  expMonth?: number;
  expYear?: number;
}

export function CardDisplay({ brand, last4, expMonth, expYear }: CardDisplayProps) {
  return (
    <div className="flex items-center gap-2">
      <CardBrandIcon brand={brand} />
      <span className="font-mono">****{last4}</span>
      {expMonth && expYear && (
        <span className="text-stripe-gray-500 text-sm">
          {String(expMonth).padStart(2, '0')}/{String(expYear).slice(-2)}
        </span>
      )}
    </div>
  );
}

function CardBrandIcon({ brand }: { brand: string }) {
  const colors: Record<string, string> = {
    visa: 'bg-blue-600',
    mastercard: 'bg-orange-500',
    amex: 'bg-blue-800',
    discover: 'bg-orange-400',
    unknown: 'bg-gray-400',
  };

  const bgColor = colors[brand] || colors.unknown;

  return (
    <div className={`w-8 h-5 ${bgColor} rounded text-white text-xs flex items-center justify-center font-bold`}>
      {brand === 'visa' ? 'V' : brand === 'mastercard' ? 'MC' : brand === 'amex' ? 'AX' : '?'}
    </div>
  );
}
