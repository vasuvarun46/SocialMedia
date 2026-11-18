# Social Post Publisher

A React + Tailwind client and Express server for approving and publishing one image and caption to Facebook Pages, Instagram professional accounts, LinkedIn, and WhatsApp recipients.

## Setup

Requires Node.js 20+. Install packages from the repository root:

    npm install
    npm install --prefix client
    npm install --prefix server

Copy server/.env.example to server/.env and add the credentials and destination IDs you use. Tokens remain server-side. Start the UI and API with npm run dev. Open http://localhost:5173; Express runs on port 3001.

MOCK_POSTING=true simulates successful calls. Set MOCK_FAIL_PLATFORMS=facebook,instagram to exercise failures and retry. For real Instagram image posts, configure PUBLIC_BASE_URL as a public HTTPS origin serving the Express /media route and set APP_PASSWORD to a strong password. This is mandatory because the server is internet-reachable; publishing routes require sign-in and use a 12-hour HTTP-only, same-site session cookie. A localhost address cannot be fetched by Instagram. A trusted HTTPS tunnel or deployment is needed.

Uploads support JPEG and PNG, up to 5 MB. Temporary uploads live in server/uploads and are cleaned after 30 minutes.

## Platform configuration

Facebook needs a Page access token, Page ID, and Page publishing permissions. Instagram needs a professional account token, account ID, and publishing permission. LinkedIn needs an access token, author URN, and supported API version. WhatsApp needs a Cloud API access token, business phone-number ID, and recipient phone number in international format. WhatsApp sends an image message to the configured recipient; it does not publish a feed or status update. A free-form message may be limited by WhatsApp conversation-window rules; use a suitable approved template where required. See server/.env.example for variable names. Missing configuration is reported as a failed result without sending an API request.

Meta and LinkedIn API versions change; set version variables to versions supported by your developer app.

## Flow and API

Compose an image, caption, and destination selection. Each selected destination has a separate approval screen. Approving calls POST /api/post/:platform with multipart fields image and caption. Declining makes no request. Results show Posted, Declined, or Failed; retry only re-sends that failed platform.

Supported platform path values are facebook, instagram, linkedin, and whatsapp. Tokens and external API calls stay on the Express server. Raw upstream errors and credentials are not returned to the browser.

## Official API references

- Facebook Page photos: https://developers.facebook.com/docs/graph-api/reference/page/photos/
- Instagram API: https://developers.facebook.com/docs/instagram/platform/instagram-api/changelog/
- LinkedIn Posts API: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
- WhatsApp Cloud API: https://developers.facebook.com/documentation/business-messaging/whatsapp/overview