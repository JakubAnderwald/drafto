#import <React/RCTBridgeModule.h>

// The OS random source and SHA-256 for JS, which Hermes lacks. Backs
// `crypto.getRandomValues` and `crypto.subtle.digest` (src/lib/crypto-random.ts)
// so supabase-js builds its PKCE verifier from a CSPRNG and sends an S256
// challenge. See docs/adr/0059-desktop-pkce-native-csprng.md.
@interface DraftoCrypto : NSObject <RCTBridgeModule>
@end
