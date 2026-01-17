import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Header, HeroBanner, ContentRow } from '../components';
import { useAuthStore } from '../stores/authStore';
import { useContentStore } from '../stores/contentStore';
import { recommendationsApi } from '../services/api';
import type { RecommendationSection } from '../types';

function HomePage() {
  const { user, currentProfile } = useAuthStore();
  const { featured, continueWatching, fetchFeatured, fetchContinueWatching } = useContentStore();
  const [recommendations, setRecommendations] = useState<RecommendationSection[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      await fetchFeatured();
      if (currentProfile) {
        await fetchContinueWatching();
        try {
          const recs = await recommendationsApi.getAll();
          setRecommendations(recs);
        } catch (error) {
          console.error('Failed to load recommendations:', error);
        }
      }
      setIsLoading(false);
    };
    loadData();
  }, [currentProfile, fetchFeatured, fetchContinueWatching]);

  const heroContent = featured[0];

  if (isLoading) {
    return (
      <>
        <Header />
        <div className="min-h-screen bg-black flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-white"></div>
        </div>
      </>
    );
  }

  return (
    <>
      <Header />
      <main>
        {/* Hero Banner */}
        {heroContent && <HeroBanner content={heroContent} />}

        {/* Content Rows */}
        <div className="relative z-10 -mt-32">
          {/* Continue Watching */}
          {continueWatching.length > 0 && (
            <ContentRow
              title="Continue Watching"
              items={continueWatching}
              showProgress
            />
          )}

          {/* Recommendation Sections */}
          {recommendations.map((section) => (
            <ContentRow
              key={section.title}
              title={section.title}
              items={section.items}
            />
          ))}

          {/* Featured */}
          {featured.length > 1 && (
            <ContentRow
              title="Featured"
              items={featured.slice(1)}
            />
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="py-12 px-8 text-center text-white/40 text-sm">
        <p>Apple TV+ Clone - System Design Learning Project</p>
        <p className="mt-2">Not affiliated with Apple Inc.</p>
      </footer>
    </>
  );
}

export const Route = createFileRoute('/')({
  component: HomePage,
});
