import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { useDocumentStore } from '../stores/documentStore';
import Header from '../components/Header';
import DocumentList from '../components/DocumentList';

export default function HomePage() {
  const { user } = useAuthStore();
  const { documents, fetchDocuments, createDocument, isLoading } = useDocumentStore();
  const navigate = useNavigate();

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  const handleCreateDocument = async () => {
    const id = await createDocument();
    if (id) {
      navigate(`/document/${id}`);
    }
  };

  return (
    <div className="min-h-screen bg-docs-bg flex flex-col">
      <Header />

      <main className="flex-1">
        {/* Create new section */}
        <div className="bg-white border-b border-docs-border">
          <div className="max-w-4xl mx-auto px-4 py-8">
            <h2 className="text-sm font-medium text-gray-600 mb-4">Start a new document</h2>
            <div className="flex gap-4">
              <button
                onClick={handleCreateDocument}
                className="group flex flex-col items-center"
              >
                <div className="w-32 h-40 border-2 border-docs-border rounded-lg bg-white hover:border-docs-blue transition-colors flex items-center justify-center group-hover:shadow-md">
                  <svg className="w-12 h-12 text-docs-blue" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                  </svg>
                </div>
                <span className="mt-2 text-sm text-gray-700">Blank</span>
              </button>
            </div>
          </div>
        </div>

        {/* Documents list */}
        <div className="max-w-4xl mx-auto px-4 py-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-medium text-gray-600">Recent documents</h2>
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500">Owned by anyone</span>
            </div>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-docs-blue"></div>
            </div>
          ) : documents.length === 0 ? (
            <div className="text-center py-12">
              <svg className="w-16 h-16 mx-auto text-gray-300 mb-4" viewBox="0 0 48 48" fill="none">
                <path d="M7 6C7 4.89543 7.89543 4 9 4H29L41 16V42C41 43.1046 40.1046 44 39 44H9C7.89543 44 7 43.1046 7 42V6Z" fill="currentColor"/>
                <path d="M29 4L41 16H31C29.8954 16 29 15.1046 29 14V4Z" fill="currentColor" opacity="0.5"/>
              </svg>
              <p className="text-gray-500">No documents yet</p>
              <button
                onClick={handleCreateDocument}
                className="mt-4 text-docs-blue hover:text-docs-blue-dark font-medium"
              >
                Create your first document
              </button>
            </div>
          ) : (
            <DocumentList documents={documents} />
          )}
        </div>
      </main>
    </div>
  );
}
