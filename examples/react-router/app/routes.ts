import { index, type RouteConfig, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('about', 'routes/about.tsx'),
  route('ssr', 'routes/ssr.tsx'),
  route('api/hello', 'routes/api.hello.ts'),
] satisfies RouteConfig;
