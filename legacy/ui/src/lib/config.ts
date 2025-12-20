// Hacky way of doing global settings...

const config = {
  siteTitle: "astrophotography.tv",
  singleUser: false,
  singleUserHost: () => process.env.SINGLE_USER_HOST || 'localhost',
  singleUserId: () => process.env.SINGLE_USER_ID || 'pHGw877RoxVkC5nPykjOQ'
};

export default config;
