import { config } from '../../config.js';
import { getJson } from './http.js';
import { str } from './util.js';

/**
 * Google Fact Check Tools claim search. Returns published fact-check articles
 * about claims similar to `query`. The API key goes in a header, not the URL,
 * so it can't leak into logs.
 */
export async function searchFactChecks(query, languageCode) {
  const params = new URLSearchParams({ query: query.slice(0, 200), pageSize: '5' });
  if (languageCode) params.set('languageCode', languageCode);
  const data = await getJson(`https://factchecktools.googleapis.com/v1alpha1/claims:search?${params}`, {
    headers: { 'X-Goog-Api-Key': config.providers.factCheckKey },
    provider: 'factcheck',
    timeoutMs: 10_000,
  });

  const reviews = [];
  for (const claim of data?.claims ?? []) {
    for (const review of claim.claimReview ?? []) {
      if (!/^https?:\/\//i.test(review?.url ?? '')) continue;
      reviews.push({
        claim: str(claim.text, 300),
        claimant: str(claim.claimant, 120) || null,
        claimDate: str(claim.claimDate, 40) || null,
        rating: str(review.textualRating, 80) || 'Rated',
        publisher: str(review.publisher?.name || review.publisher?.site, 80) || 'Fact-checker',
        url: review.url,
        title: str(review.title, 200) || null,
        reviewDate: str(review.reviewDate, 40) || null,
      });
    }
  }
  return reviews;
}