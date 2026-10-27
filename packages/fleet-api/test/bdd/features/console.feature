Feature: Use the shared Fleet admin console
  Scenario: Keep drafts during navigation and recover from invalid settings
    When I open Fleet settings
    And I change the heartbeat interval
    And I try to leave settings
    Then Fleet asks before discarding my draft
    When I keep editing and save settings
    Then my settings are saved
    When I submit invalid raw settings
    Then the error preserves my raw draft

  Scenario: Remember appearance and follow system changes
    When I open Fleet settings
    Then light and dark choices persist and system mode follows the operating system
