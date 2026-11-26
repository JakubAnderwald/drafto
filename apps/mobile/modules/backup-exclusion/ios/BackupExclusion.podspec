# The app's own Expo module (ADR-0107), autolinked from apps/mobile/modules.
# It has no package.json, so its details are written out here.
Pod::Spec.new do |s|
  s.name           = 'BackupExclusion'
  s.version        = '1.0.0'
  s.summary        = 'Keeps a folder out of iCloud and device backups.'
  s.description    = 'Sets NSURLIsExcludedFromBackupKey on a folder for the Drafto app.'
  s.license        = 'UNLICENSED'
  s.author         = 'Drafto'
  s.homepage       = 'https://drafto.eu'
  s.platforms      = {
    :ios => '15.1'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
