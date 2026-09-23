#import <Foundation/Foundation.h>
#import <Security/Security.h>

static void printStatus(OSStatus status) {
  CFStringRef description = SecCopyErrorMessageString(status, NULL);
  NSString *message = CFBridgingRelease(description) ?: @"unknown Keychain error";
  fprintf(stderr, "%s\n", message.UTF8String);
}

static NSMutableDictionary *baseQuery(NSString *service, NSString *account) {
  return [@{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: service,
    (__bridge id)kSecAttrAccount: account,
  } mutableCopy];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 4) {
      fprintf(stderr, "usage: credential-helper get|set|delete <service> <account>\n");
      return 64;
    }

    NSString *command = [NSString stringWithUTF8String:argv[1]];
    NSString *service = [NSString stringWithUTF8String:argv[2]];
    NSString *account = [NSString stringWithUTF8String:argv[3]];
    if (!command || !service || !account || service.length == 0 || account.length == 0) {
      fprintf(stderr, "invalid UTF-8 argument\n");
      return 64;
    }

    NSMutableDictionary *query = baseQuery(service, account);
    if ([command isEqualToString:@"get"]) {
      query[(__bridge id)kSecReturnData] = @YES;
      query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
      CFTypeRef result = NULL;
      OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
      if (status == errSecItemNotFound) return 44;
      if (status != errSecSuccess) {
        printStatus(status);
        return 1;
      }
      NSData *data = CFBridgingRelease(result);
      [[NSFileHandle fileHandleWithStandardOutput] writeData:data];
      return 0;
    }

    if ([command isEqualToString:@"set"]) {
      NSData *data = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
      NSDictionary *attributes = @{(__bridge id)kSecValueData: data};
      OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)query,
                                      (__bridge CFDictionaryRef)attributes);
      if (status == errSecItemNotFound) {
        query[(__bridge id)kSecValueData] = data;
        status = SecItemAdd((__bridge CFDictionaryRef)query, NULL);
      }
      if (status != errSecSuccess) {
        printStatus(status);
        return 1;
      }
      return 0;
    }

    if ([command isEqualToString:@"delete"]) {
      OSStatus status = SecItemDelete((__bridge CFDictionaryRef)query);
      if (status == errSecItemNotFound) return 44;
      if (status != errSecSuccess) {
        printStatus(status);
        return 1;
      }
      return 0;
    }

    fprintf(stderr, "unknown command\n");
    return 64;
  }
}
