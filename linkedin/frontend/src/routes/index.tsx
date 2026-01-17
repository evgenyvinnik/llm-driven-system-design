import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { feedApi, connectionsApi } from '../services/api';
import type { Post, PYMKCandidate } from '../types';
import { PostCard } from '../components/PostCard';
import { ConnectionCard } from '../components/ConnectionCard';
import { Link } from '@tanstack/react-router';
import { Image, Calendar, FileText } from 'lucide-react';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const { isAuthenticated, user } = useAuthStore();
  const navigate = useNavigate();
  const [posts, setPosts] = useState<Post[]>([]);
  const [pymk, setPymk] = useState<PYMKCandidate[]>([]);
  const [newPostContent, setNewPostContent] = useState('');
  const [loadingPosts, setLoadingPosts] = useState(true);
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }

    const loadData = async () => {
      try {
        const [feedResponse, pymkResponse] = await Promise.all([
          feedApi.getFeed(),
          connectionsApi.getPYMK(5),
        ]);
        setPosts(feedResponse.posts);
        setPymk(pymkResponse.people);
      } catch (error) {
        console.error('Failed to load data:', error);
      }
      setLoadingPosts(false);
    };

    loadData();
  }, [isAuthenticated, navigate]);

  const handleCreatePost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPostContent.trim()) return;

    setPosting(true);
    try {
      const { post } = await feedApi.createPost(newPostContent);
      setPosts([{ ...post, author: user! }, ...posts]);
      setNewPostContent('');
    } catch (error) {
      console.error('Failed to create post:', error);
    }
    setPosting(false);
  };

  if (!isAuthenticated) {
    return null;
  }

  return (
    <main className="max-w-7xl mx-auto px-4 py-6">
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Left Sidebar - Profile Card */}
        <div className="lg:col-span-1">
          <div className="card">
            <div className="h-14 bg-gradient-to-r from-linkedin-blue to-blue-400 rounded-t-lg" />
            <div className="px-4 pb-4 -mt-8">
              <Link to="/profile/$userId" params={{ userId: String(user?.id) }}>
                <div className="w-16 h-16 rounded-full bg-white border-2 border-white flex items-center justify-center text-2xl font-bold bg-gray-300 mx-auto">
                  {user?.first_name?.[0]}
                </div>
              </Link>
              <Link
                to="/profile/$userId"
                params={{ userId: String(user?.id) }}
                className="block text-center mt-2"
              >
                <div className="font-semibold hover:underline">
                  {user?.first_name} {user?.last_name}
                </div>
              </Link>
              <div className="text-sm text-gray-600 text-center mt-1">
                {user?.headline}
              </div>
            </div>
            <hr />
            <div className="p-4 text-sm">
              <Link
                to="/network"
                className="flex justify-between text-gray-600 hover:text-linkedin-blue"
              >
                <span>Connections</span>
                <span className="font-semibold text-linkedin-blue">
                  {user?.connection_count}
                </span>
              </Link>
            </div>
          </div>
        </div>

        {/* Main Feed */}
        <div className="lg:col-span-2 space-y-4">
          {/* Create Post */}
          <div className="card p-4">
            <form onSubmit={handleCreatePost}>
              <div className="flex items-start gap-3">
                <div className="w-12 h-12 rounded-full bg-gray-300 flex items-center justify-center font-bold flex-shrink-0">
                  {user?.first_name?.[0]}
                </div>
                <input
                  type="text"
                  value={newPostContent}
                  onChange={(e) => setNewPostContent(e.target.value)}
                  placeholder="Start a post"
                  className="flex-1 border border-gray-300 rounded-full px-4 py-3 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-linkedin-blue"
                />
              </div>
              <div className="flex items-center justify-between mt-3">
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    className="flex items-center gap-2 text-gray-600 hover:bg-gray-100 px-3 py-2 rounded"
                  >
                    <Image className="w-5 h-5 text-blue-500" />
                    <span className="text-sm font-medium">Photo</span>
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-2 text-gray-600 hover:bg-gray-100 px-3 py-2 rounded"
                  >
                    <Calendar className="w-5 h-5 text-orange-500" />
                    <span className="text-sm font-medium">Event</span>
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-2 text-gray-600 hover:bg-gray-100 px-3 py-2 rounded"
                  >
                    <FileText className="w-5 h-5 text-red-500" />
                    <span className="text-sm font-medium">Article</span>
                  </button>
                </div>
                {newPostContent.trim() && (
                  <button
                    type="submit"
                    disabled={posting}
                    className="btn-primary text-sm disabled:opacity-50"
                  >
                    {posting ? 'Posting...' : 'Post'}
                  </button>
                )}
              </div>
            </form>
          </div>

          {/* Posts */}
          {loadingPosts ? (
            <div className="card p-8 text-center text-gray-500">
              Loading feed...
            </div>
          ) : posts.length === 0 ? (
            <div className="card p-8 text-center text-gray-500">
              No posts yet. Connect with people to see their posts!
            </div>
          ) : (
            posts.map((post) => <PostCard key={post.id} post={post} />)
          )}
        </div>

        {/* Right Sidebar - PYMK */}
        <div className="lg:col-span-1">
          <div className="card p-4">
            <h3 className="font-semibold mb-4">People you may know</h3>
            {pymk.length === 0 ? (
              <div className="text-sm text-gray-500 text-center py-4">
                No suggestions yet
              </div>
            ) : (
              <div className="space-y-4">
                {pymk.map((candidate) => (
                  <div key={candidate.user.id} className="flex items-start gap-3">
                    <Link to="/profile/$userId" params={{ userId: String(candidate.user.id) }}>
                      <div className="w-12 h-12 rounded-full bg-gray-300 flex items-center justify-center font-bold flex-shrink-0">
                        {candidate.user.first_name?.[0]}
                      </div>
                    </Link>
                    <div className="flex-1 min-w-0">
                      <Link
                        to="/profile/$userId"
                        params={{ userId: String(candidate.user.id) }}
                        className="font-semibold text-sm hover:text-linkedin-blue hover:underline block truncate"
                      >
                        {candidate.user.first_name} {candidate.user.last_name}
                      </Link>
                      <div className="text-xs text-gray-600 truncate">
                        {candidate.user.headline}
                      </div>
                      {candidate.mutual_connections > 0 && (
                        <div className="text-xs text-gray-500 mt-1">
                          {candidate.mutual_connections} mutual
                        </div>
                      )}
                      <button className="btn-secondary text-xs mt-2 py-1 px-3">
                        Connect
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
