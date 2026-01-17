/**
 * Signature modal component for capturing signatures and initials.
 * Supports both drawn and typed signatures.
 *
 * @param props - Component props
 * @returns The signature capture modal
 */
import { useEffect, useRef, useState } from 'react';
import SignaturePad from 'signature_pad';
import { DocumentField } from '../../types';
import { CloseIcon } from '../icons/CloseIcon';

interface SignatureModalProps {
  /** Whether the modal is visible */
  isOpen: boolean;
  /** The field being signed */
  activeField: DocumentField | null;
  /** Handler to close the modal */
  onClose: () => void;
  /** Handler to submit the signature */
  onSign: (signatureData: string, signatureType: 'draw' | 'typed') => void;
  /** Error message to display */
  error?: string;
}

export function SignatureModal({
  isOpen,
  activeField,
  onClose,
  onSign,
  error,
}: SignatureModalProps) {
  const [signatureType, setSignatureType] = useState<'draw' | 'typed'>('draw');
  const [typedSignature, setTypedSignature] = useState('');
  const signaturePadRef = useRef<SignaturePad | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Initialize signature pad when modal opens
  useEffect(() => {
    if (isOpen && canvasRef.current && signatureType === 'draw') {
      signaturePadRef.current = new SignaturePad(canvasRef.current, {
        backgroundColor: 'rgb(255, 255, 255)',
        penColor: 'rgb(0, 0, 0)',
      });
    }

    return () => {
      if (signaturePadRef.current) {
        signaturePadRef.current.off();
      }
    };
  }, [isOpen, signatureType]);

  /**
   * Clears the drawn signature.
   */
  const handleClear = () => {
    signaturePadRef.current?.clear();
  };

  /**
   * Creates a signature image from typed text.
   */
  const createTypedSignatureImage = (text: string): string => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 100;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'black';
    ctx.font = 'italic 36px "Brush Script MT", cursive';
    ctx.fillText(text, 20, 60);
    return canvas.toDataURL('image/png');
  };

  /**
   * Handles signature submission.
   */
  const handleSubmit = () => {
    if (signatureType === 'draw') {
      if (!signaturePadRef.current || signaturePadRef.current.isEmpty()) {
        return;
      }
      const signatureData = signaturePadRef.current.toDataURL('image/png');
      onSign(signatureData, 'draw');
    } else {
      if (!typedSignature.trim()) {
        return;
      }
      const signatureData = createTypedSignatureImage(typedSignature);
      onSign(signatureData, 'typed');
    }
  };

  /**
   * Handles modal close and cleanup.
   */
  const handleClose = () => {
    setTypedSignature('');
    signaturePadRef.current?.clear();
    onClose();
  };

  if (!isOpen) {
    return null;
  }

  const title = activeField?.type === 'initial' ? 'Add Your Initials' : 'Add Your Signature';

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-lg">
        <ModalHeader title={title} onClose={handleClose} />

        <SignatureTypeTabs
          signatureType={signatureType}
          onTypeChange={setSignatureType}
        />

        {error && (
          <div className="text-red-600 text-sm mb-4">{error}</div>
        )}

        {signatureType === 'draw' ? (
          <DrawSignatureInput
            canvasRef={canvasRef}
            onClear={handleClear}
          />
        ) : (
          <TypeSignatureInput
            value={typedSignature}
            onChange={setTypedSignature}
          />
        )}

        <ModalFooter onCancel={handleClose} onSubmit={handleSubmit} />
      </div>
    </div>
  );
}

/**
 * Modal header with title and close button.
 */
interface ModalHeaderProps {
  title: string;
  onClose: () => void;
}

function ModalHeader({ title, onClose }: ModalHeaderProps) {
  return (
    <div className="flex justify-between items-center mb-4">
      <h2 className="text-xl font-bold">{title}</h2>
      <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
        <CloseIcon className="w-6 h-6" />
      </button>
    </div>
  );
}

/**
 * Tabs for switching between draw and type modes.
 */
interface SignatureTypeTabsProps {
  signatureType: 'draw' | 'typed';
  onTypeChange: (type: 'draw' | 'typed') => void;
}

function SignatureTypeTabs({ signatureType, onTypeChange }: SignatureTypeTabsProps) {
  const getTabClass = (type: 'draw' | 'typed') =>
    signatureType === type
      ? 'border-b-2 border-docusign-blue text-docusign-blue'
      : 'text-gray-500';

  return (
    <div className="flex border-b mb-4">
      <button
        onClick={() => onTypeChange('draw')}
        className={`flex-1 py-2 text-center font-medium ${getTabClass('draw')}`}
      >
        Draw
      </button>
      <button
        onClick={() => onTypeChange('typed')}
        className={`flex-1 py-2 text-center font-medium ${getTabClass('typed')}`}
      >
        Type
      </button>
    </div>
  );
}

/**
 * Canvas for drawing signatures.
 */
interface DrawSignatureInputProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  onClear: () => void;
}

function DrawSignatureInput({ canvasRef, onClear }: DrawSignatureInputProps) {
  return (
    <div className="signature-pad-container">
      <canvas
        ref={canvasRef}
        width={450}
        height={150}
        className="w-full rounded-lg"
      />
      <button
        onClick={onClear}
        className="absolute top-2 right-2 text-sm text-gray-500 hover:text-gray-700"
      >
        Clear
      </button>
    </div>
  );
}

/**
 * Input for typing signatures.
 */
interface TypeSignatureInputProps {
  value: string;
  onChange: (value: string) => void;
}

function TypeSignatureInput({ value, onChange }: TypeSignatureInputProps) {
  return (
    <div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Type your name"
        className="w-full px-4 py-3 border rounded-lg text-2xl italic font-serif"
      />
      {value && (
        <div className="mt-4 p-4 bg-gray-50 rounded-lg">
          <p className="text-sm text-gray-500 mb-2">Preview:</p>
          <p className="text-3xl italic font-serif">{value}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Modal footer with action buttons.
 */
interface ModalFooterProps {
  onCancel: () => void;
  onSubmit: () => void;
}

function ModalFooter({ onCancel, onSubmit }: ModalFooterProps) {
  return (
    <div className="flex justify-end space-x-3 mt-6">
      <button
        onClick={onCancel}
        className="px-4 py-2 border rounded-lg text-gray-700 hover:bg-gray-50"
      >
        Cancel
      </button>
      <button
        onClick={onSubmit}
        className="px-4 py-2 bg-docusign-blue text-white rounded-lg font-medium hover:bg-docusign-dark"
      >
        Apply Signature
      </button>
    </div>
  );
}
