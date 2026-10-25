#import "DraftoCrypto.h"

#import <CommonCrypto/CommonDigest.h>
#import <Security/SecRandom.h>

// WebCrypto's per-call limit for getRandomValues; the JS side enforces it too.
static const double DraftoCryptoMaxRandomBytes = 65536;

// Bytes cross the bridge as plain arrays of numbers (0-255). The payloads are a
// few hundred bytes at most, so neither side needs a base64 codec.
static NSArray<NSNumber *> *DraftoCryptoByteArray(const uint8_t *bytes, size_t length)
{
  NSMutableArray<NSNumber *> *array = [NSMutableArray arrayWithCapacity:length];
  for (size_t i = 0; i < length; i++) {
    [array addObject:@(bytes[i])];
  }
  return array;
}

@implementation DraftoCrypto

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

#pragma mark - Exported Methods

// Blocking and synchronous because getRandomValues is: auth-js fills its
// verifier inline and reads it on the next line. A pre-seeded JS pool was
// rejected (ADR-0059): it needs refill logic and keeps future secret bytes on
// the JS heap, while a sync call costs one JS-thread round trip per sign-in.
// Under the new-architecture interop layer it runs inline on the JS thread, so
// keep it cheap.
//
// Returns nil (null in JS) on a bad length or when SecRandomCopyBytes fails,
// never zero-filled bytes. The JS side treats null as a hard failure. It never
// raises: a sync exception reaches JS only if it carries a reason.
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(randomBytes:(double)length)
{
  if (!(length >= 1 && length <= DraftoCryptoMaxRandomBytes) || length != floor(length)) {
    return nil;
  }
  size_t count = (size_t)length;
  NSMutableData *buffer = [NSMutableData dataWithLength:count];
  if (buffer == nil || SecRandomCopyBytes(kSecRandomDefault, count, buffer.mutableBytes) != errSecSuccess) {
    return nil;
  }
  return DraftoCryptoByteArray((const uint8_t *)buffer.bytes, count);
}

// Asynchronous, because crypto.subtle.digest returns a promise anyway. Typed as
// a plain NSArray: under the interop layer, NSArray<NSNumber *> goes through
// RCTConvert NSNumberArray:, which in Debug drops bad elements and shifts the
// rest. Each element is checked here instead, and the method always resolves
// or rejects; an exception thrown on the method queue would crash the app.
RCT_EXPORT_METHOD(sha256:(NSArray *)bytes
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  // In Release, RCTConvert passes a non-array (or nil) through unchecked.
  if (![bytes isKindOfClass:[NSArray class]]) {
    reject(@"E_INVALID_BYTES", @"sha256 expects an array of byte values (0-255)", nil);
    return;
  }
  NSMutableData *input = [NSMutableData dataWithLength:bytes.count];
  uint8_t *raw = (uint8_t *)input.mutableBytes;
  for (NSUInteger i = 0; i < bytes.count; i++) {
    id value = bytes[i];
    double byte = [value isKindOfClass:[NSNumber class]] ? [value doubleValue] : -1;
    if (!(byte >= 0 && byte <= 255) || byte != floor(byte)) {
      reject(@"E_INVALID_BYTES", @"sha256 expects an array of byte values (0-255)", nil);
      return;
    }
    raw[i] = (uint8_t)byte;
  }

  uint8_t digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(input.bytes, (CC_LONG)input.length, digest);
  resolve(DraftoCryptoByteArray(digest, CC_SHA256_DIGEST_LENGTH));
}

@end
