# frozen_string_literal: true

# Pure helpers for the Android (Google Play) lanes in ./Fastfile. They hold no
# fastlane state, so scripts/__tests__/play-release.test.mjs loads this file with
# plain `ruby` and checks them without fastlane, a Play account or a build.
module PlayRelease
  # Every Play track a release can sit on. Play needs a version code that is
  # unique across the whole app and higher than any code already uploaded, so
  # the next code is computed from all of them, not just the target track: the
  # internal track was at 87 while closed testing (alpha) held 82, so "alpha max
  # + 1" would have tried to reuse 83, which Play rejects.
  TRACKS = %w[internal alpha beta production].freeze

  # Raised when no track could be read at all. Counting up from 0 would only
  # fail later, at upload, with a less obvious "version code already used".
  class AllTracksUnreadable < StandardError; end

  # Calls the block once per track and returns [codes_by_track, errors_by_track].
  # A track the block raises for (one with no releases, or one never set up) is
  # recorded as [] plus its error message, so one empty track cannot stop a
  # release that the other tracks have enough information for.
  def self.collect_version_codes(tracks = TRACKS)
    codes = {}
    errors = {}
    tracks.each do |track|
      codes[track] = Array(yield(track)).map(&:to_i)
    rescue StandardError => e
      codes[track] = []
      errors[track] = e.message
    end
    [codes, errors]
  end

  # One above the highest code on any track.
  def self.next_version_code(codes, errors = {})
    if codes.empty? || errors.size >= codes.size
      raise AllTracksUnreadable,
            "Could not read version codes from any Google Play track (#{errors.keys.join(', ')}). " \
            "Check the service-account key and network before building."
    end

    (codes.values.flatten.max || 0) + 1
  end

  # The channel name in the customer-facing "Now live in <label>." comment and
  # the In Test build comment.
  def self.track_label(track, build)
    channel =
      case track
      when "production" then "Google Play"
      when "internal" then "Google Play internal track"
      when "alpha" then "Google Play closed testing"
      when "beta" then "Google Play open testing"
      else raise ArgumentError, "Unknown Google Play track: #{track.inspect}"
      end
    "#{channel} (build #{build})"
  end

  # Whether a release on this track posts "Now live" on the support issues it
  # closes. Closed testing (alpha) is a hand-picked tester list that the people
  # who reported an issue are generally not on, so the notice would point them
  # at a build they cannot install. An issue is announced once per platform
  # (scripts/lib/now-live.mjs), so an alpha notice would also suppress the
  # internal-track or production one they could act on.
  def self.announces_release?(track)
    %w[internal production].include?(track)
  end
end
