/**
 * @fileoverview Form component for generating test click events.
 * Allows sending single or batch clicks with configurable parameters.
 * Useful for testing the ingestion pipeline and fraud detection.
 */

import { useState } from 'react';
import { sendTestClick, sendBatchClicks } from '../services/api';

/**
 * Props for the TestClickForm component.
 */
interface TestClickFormProps {
  /** Available ads to select from */
  ads: { id: string; campaign_id: string; name: string }[];
  /** Available campaigns (for advertiser lookup) */
  campaigns: { id: string; advertiser_id: string; name: string }[];
  /** Callback after successful click submission */
  onSuccess?: () => void;
}

/** List of country codes for test data */
const COUNTRIES = ['US', 'CA', 'UK', 'DE', 'FR', 'JP', 'AU', 'BR', 'IN', 'MX'];

/** Device type options */
const DEVICE_TYPES = ['desktop', 'mobile', 'tablet'] as const;

/**
 * Form for sending test click events to the backend.
 * Supports single clicks and batch generation with randomization.
 *
 * @param props - Form configuration and callbacks
 * @returns Interactive form with result display
 */
export function TestClickForm({ ads, campaigns, onSuccess }: TestClickFormProps) {
  const [selectedAd, setSelectedAd] = useState('');
  const [deviceType, setDeviceType] = useState<'desktop' | 'mobile' | 'tablet'>('desktop');
  const [country, setCountry] = useState('US');
  const [batchSize, setBatchSize] = useState(10);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const selectedAdData = ads.find((ad) => ad.id === selectedAd);
  const selectedCampaign = campaigns.find((c) => c.id === selectedAdData?.campaign_id);

  const handleSingleClick = async () => {
    if (!selectedAdData || !selectedCampaign) return;

    setIsLoading(true);
    setResult(null);

    try {
      const response = await sendTestClick({
        ad_id: selectedAdData.id,
        campaign_id: selectedAdData.campaign_id,
        advertiser_id: selectedCampaign.advertiser_id,
        device_type: deviceType,
        country,
        user_id: `user_${Math.random().toString(36).substring(7)}`,
      });

      setResult(
        `Click recorded! ID: ${response.click_id}${response.is_fraudulent ? ' (Flagged as fraud)' : ''}`
      );
      onSuccess?.();
    } catch (error) {
      setResult(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleBatchClicks = async () => {
    if (!selectedAdData || !selectedCampaign) return;

    setIsLoading(true);
    setResult(null);

    try {
      const clicks = Array.from({ length: batchSize }, () => ({
        ad_id: selectedAdData.id,
        campaign_id: selectedAdData.campaign_id,
        advertiser_id: selectedCampaign.advertiser_id,
        device_type: DEVICE_TYPES[Math.floor(Math.random() * DEVICE_TYPES.length)],
        country: COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)],
        user_id: `user_${Math.random().toString(36).substring(7)}`,
      }));

      const response = await sendBatchClicks(clicks);
      setResult(
        `Batch complete! Processed: ${response.processed}, Success: ${response.success_count}, Fraud: ${response.fraud_count}`
      );
      onSuccess?.();
    } catch (error) {
      setResult(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <h3 className="mb-4 text-lg font-semibold text-gray-900">Generate Test Clicks</h3>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Select Ad</label>
          <select
            value={selectedAd}
            onChange={(e) => setSelectedAd(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">Choose an ad...</option>
            {ads.map((ad) => (
              <option key={ad.id} value={ad.id}>
                {ad.name} ({ad.id})
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Device Type</label>
            <select
              value={deviceType}
              onChange={(e) => setDeviceType(e.target.value as 'desktop' | 'mobile' | 'tablet')}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {DEVICE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Country</label>
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {COUNTRIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">
            Batch Size (for bulk generation)
          </label>
          <input
            type="number"
            min={1}
            max={1000}
            value={batchSize}
            onChange={(e) => setBatchSize(Math.min(1000, Math.max(1, parseInt(e.target.value) || 1)))}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleSingleClick}
            disabled={!selectedAd || isLoading}
            className="flex-1 rounded-md bg-blue-600 px-4 py-2 text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoading ? 'Sending...' : 'Send Single Click'}
          </button>
          <button
            onClick={handleBatchClicks}
            disabled={!selectedAd || isLoading}
            className="flex-1 rounded-md bg-green-600 px-4 py-2 text-white transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoading ? 'Sending...' : `Send ${batchSize} Clicks`}
          </button>
        </div>

        {result && (
          <div
            className={`rounded-md p-3 text-sm ${
              result.startsWith('Error')
                ? 'bg-red-50 text-red-700'
                : 'bg-green-50 text-green-700'
            }`}
          >
            {result}
          </div>
        )}
      </div>
    </div>
  );
}
