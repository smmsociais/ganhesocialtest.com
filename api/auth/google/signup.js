export default async function handler(req, res) {
  const redirectUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    `client_id=${process.env.GOOGLE_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.GOOGLE_REDIRECT_URI_SIGNUP)}` +
    `&response_type=code` +
    `&prompt=select_account` +
    `&scope=openid%20email%20profile`;

  return res.redirect(redirectUrl);
}
