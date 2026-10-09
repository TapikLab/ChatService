import { Metadata } from '@grpc/grpc-js';

export function buildInternalGrpcMetadata(internalApiKey: string): Metadata {
  const metadata = new Metadata();
  metadata.set('x-internal-key', internalApiKey);
  return metadata;
}
