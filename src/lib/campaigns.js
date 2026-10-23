// Public placement codes only. Never retain a URL, search term, referrer,
// click ID or arbitrary UTM value in a contact record or analytics event.
// Attribution describes the submitted page, not a verified first touch.
const placements = [
  ['youtube-channel-profile', 'youtube', 'organic_video', 'grantplan_shorts_launch_202610', 'channel_profile'],
  ['youtube-channel-worksheet', 'youtube', 'organic_video', 'grantplan_shorts_launch_202610', 'channel_worksheet'],
  ['youtube-heist-202610', 'youtube', 'organic_video', 'heist_202610', 'short'],
  ['facebook-heist-202610', 'facebook', 'organic_video', 'heist_202610', 'reel'],
  ['facebook-page-profile', 'facebook', 'organic_social', 'page_profile', 'website'],
  ['facebook-business-faces', 'facebook', 'organic_social', 'business_faces_202610', 'photo_gallery'],
  ['instagram-reel-napkin27', 'instagram', 'social', 'napkin27_202610', 'reel_napkin27'],
  ['instagram-profile-napkin27', 'instagram', 'social', 'napkin27_202610', 'profile_napkin27'],
  ['facebook-reel-napkin27', 'facebook', 'social', 'napkin27_202610', 'reel_napkin27'],
  ['facebook-group-napkin27', 'facebook', 'social', 'napkin27_202610', 'group_employer_draft'],
  ['telegram-post-napkin27', 'telegram', 'social', 'napkin27_202610', 'post_napkin27'],
  ['tiktok-profile-napkin27', 'tiktok', 'social', 'napkin27_202610', 'profile_napkin27'],
  ['partner-education-napkin27', 'partner', 'referral', 'napkin27_202610', 'educational_collab_draft'],
  ['youtube-budget-guide', 'youtube', 'video', 'budget_202610', 'guide'],
  ['facebook-budget-guide', 'facebook', 'social', 'budget_202610', 'post'],
  ['telegram-budget-guide', 'telegram', 'social', 'budget_202610', 'post'],
  ['facebook-budget-cards-oct18', 'facebook', 'organic_social', 'organic_cycle_202610', 'budget_cards_20261018'],
  ['facebook-plan-scope-oct20', 'facebook', 'organic_social', 'organic_cycle_202610', 'plan_scope_20261020'],
  ['facebook-audit-prep-oct22', 'facebook', 'organic_social', 'organic_cycle_202610', 'audit_prep_20261022'],
  // Registration prepares attribution only; it never enables advertising or posting.
  ['google-search-plan-pilot', 'google', 'cpc', 'search_pilot_202610', 'plan'],
  ['google-search-support-pilot', 'google', 'cpc', 'search_pilot_202610', 'support'],
  ['google-search-vlasna-pilot', 'google', 'cpc', 'search_pilot_202610', 'vlasna'],
  ['youtube-halloween-202610', 'youtube', 'organic_video', 'halloween_202610', 'short'],
  ['facebook-halloween-202610', 'facebook', 'organic_video', 'halloween_202610', 'reel'],
  ['instagram-halloween-202610', 'instagram', 'organic_video', 'halloween_202610', 'profile'],
  ['telegram-halloween-202610', 'telegram', 'organic_social', 'halloween_202610', 'post'],
  ['youtube-flatlay-202610', 'youtube', 'organic_video', 'flatlay_202610', 'short'],
  ['facebook-flatlay-202610', 'facebook', 'organic_video', 'flatlay_202610', 'reel'],
  ['instagram-flatlay-202610', 'instagram', 'organic_video', 'flatlay_202610', 'profile'],
  ['telegram-flatlay-202610', 'telegram', 'organic_social', 'flatlay_202610', 'post'],
];

export const CAMPAIGNS = Object.freeze(placements.map(([id, source, medium, campaign, content]) =>
  Object.freeze({ id, source, medium, campaign, content })));

export function getCampaign(id) {
  return typeof id === 'string' && id.length <= 64
    ? CAMPAIGNS.find(c => c.id === id) : undefined;
}

export function campaignFromUrl(url) {
  try {
    const params = new URL(url).searchParams;
    const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];
    if (keys.some(key => params.getAll(key).length !== 1)) return '';
    return CAMPAIGNS.find(c => [c.source, c.medium, c.campaign, c.content]
      .every((value, i) => params.get(keys[i]) === value))?.id || '';
  } catch { return ''; }
}

export function campaignUrl(id, path = '/') {
  const campaign = getCampaign(id);
  if (!campaign) throw new Error('Unknown public campaign code');
  const url = new URL(path, 'https://grantplan.com.ua');
  if (url.origin !== 'https://grantplan.com.ua') throw new Error('Campaign links must use the site origin');
  for (const key of ['source', 'medium', 'campaign', 'content']) url.searchParams.set(`utm_${key}`, campaign[key]);
  return url.href;
}
