-- Second look (the owner's decision of 19 Nov 2026).
-- A queued post whose title, venue, date or city could not be established is
-- looked up once through Anthropic's web search. The lookup is paid, so a post
-- gets one ever: this is when it was made. What it found is kept on the review
-- item (review_queue.payload -> 'secondLook').
-- (013 is taken by the artist tracking migration in PR #35; migrations are
-- applied by name, so the order the two reach production does not matter.)

ALTER TABLE raw_posts ADD COLUMN second_look_at timestamptz;
