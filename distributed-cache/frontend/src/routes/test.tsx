import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { cacheApi } from '../services/api';

export const Route = createFileRoute('/test')({
  component: TestPage,
});

function TestPage() {
  const [key, setKey] = useState('test:key');
  const [value, setValue] = useState('Hello, World!');
  const [ttl, setTtl] = useState('0');
  const [result, setResult] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);

  const logResult = (action: string, data: unknown) => {
    const timestamp = new Date().toLocaleTimeString();
    const formatted = JSON.stringify(data, null, 2);
    setResult((prev) => `[${timestamp}] ${action}:\n${formatted}\n\n${prev}`);
  };

  const handleSet = async () => {
    setIsLoading(true);
    try {
      let parsedValue: unknown = value;
      try {
        parsedValue = JSON.parse(value);
      } catch {
        // Keep as string
      }

      const response = await cacheApi.set(key, parsedValue, parseInt(ttl) || undefined);
      logResult('SET', response);
    } catch (err) {
      logResult('SET ERROR', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsLoading(false);
    }
  };

  const handleGet = async () => {
    setIsLoading(true);
    try {
      const response = await cacheApi.get(key);
      logResult('GET', response);
    } catch (err) {
      logResult('GET ERROR', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    setIsLoading(true);
    try {
      const response = await cacheApi.delete(key);
      logResult('DELETE', response);
    } catch (err) {
      logResult('DELETE ERROR', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsLoading(false);
    }
  };

  const handleIncr = async () => {
    setIsLoading(true);
    try {
      const response = await cacheApi.incr(key, 1);
      logResult('INCR', response);
    } catch (err) {
      logResult('INCR ERROR', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsLoading(false);
    }
  };

  const handleLocate = async () => {
    setIsLoading(true);
    try {
      const response = await cacheApi.locateKey(key);
      logResult('LOCATE', response);
    } catch (err) {
      logResult('LOCATE ERROR', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsLoading(false);
    }
  };

  const handleBulkInsert = async () => {
    setIsLoading(true);
    const count = 100;
    const results = { success: 0, failed: 0 };

    for (let i = 0; i < count; i++) {
      try {
        await cacheApi.set(`bulk:${i}`, { index: i, timestamp: Date.now() });
        results.success++;
      } catch {
        results.failed++;
      }
    }

    logResult(`BULK INSERT (${count} keys)`, results);
    setIsLoading(false);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-800">Test Cache Operations</h2>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Input Form */}
        <div className="card space-y-4">
          <h3 className="text-lg font-semibold">Operations</h3>

          <div>
            <label className="label">Key</label>
            <input
              type="text"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="input"
              placeholder="Enter key"
            />
          </div>

          <div>
            <label className="label">Value (JSON or string)</label>
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="input h-24"
              placeholder='Enter value (e.g., "hello" or {"name":"John"})'
            />
          </div>

          <div>
            <label className="label">TTL (seconds, 0 for no expiration)</label>
            <input
              type="number"
              value={ttl}
              onChange={(e) => setTtl(e.target.value)}
              className="input"
              placeholder="0"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleSet}
              disabled={isLoading}
              className="btn btn-primary"
            >
              SET
            </button>
            <button
              onClick={handleGet}
              disabled={isLoading}
              className="btn btn-secondary"
            >
              GET
            </button>
            <button
              onClick={handleDelete}
              disabled={isLoading}
              className="btn btn-danger"
            >
              DELETE
            </button>
            <button
              onClick={handleIncr}
              disabled={isLoading}
              className="btn btn-secondary"
            >
              INCR
            </button>
            <button
              onClick={handleLocate}
              disabled={isLoading}
              className="btn btn-secondary"
            >
              LOCATE
            </button>
          </div>

          <hr className="my-4" />

          <div>
            <h4 className="font-medium mb-2">Bulk Operations</h4>
            <button
              onClick={handleBulkInsert}
              disabled={isLoading}
              className="btn btn-secondary"
            >
              Insert 100 Test Keys
            </button>
          </div>
        </div>

        {/* Results */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold">Results</h3>
            <button
              onClick={() => setResult('')}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Clear
            </button>
          </div>
          <pre className="bg-gray-900 text-green-400 p-4 rounded-lg overflow-auto h-96 text-sm font-mono">
            {result || 'Results will appear here...'}
          </pre>
        </div>
      </div>

      {/* Quick Tips */}
      <div className="card bg-blue-50">
        <h3 className="text-lg font-semibold text-blue-900 mb-2">Quick Tips</h3>
        <ul className="text-sm text-blue-800 space-y-1">
          <li>
            Use keys like <code className="bg-blue-100 px-1 rounded">user:123</code> or{' '}
            <code className="bg-blue-100 px-1 rounded">session:abc</code> to see consistent hashing in
            action
          </li>
          <li>The LOCATE operation shows which node stores the key</li>
          <li>Try inserting 100 test keys and check the Keys page to see distribution</li>
          <li>Set a TTL and watch the key expire automatically</li>
        </ul>
      </div>
    </div>
  );
}
