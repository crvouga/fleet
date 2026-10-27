@local
Feature: Offer installation paths supported by the current platform
  Scenario Outline: Explain whether this computer can become a node
    Given I open the wizard on "<os>" with "<arch>" hardware
    Then in-place installation is "<availability>"
    And making installation media remains available

    Examples:
      | os      | arch    | availability |
      | Linux   | x86_64  | available    |
      | Windows | AMD64   | available    |
      | Darwin  | x86_64  | unavailable  |
      | Darwin  | arm64   | unavailable  |
      | Linux   | aarch64 | unavailable  |

  Scenario: A second internal disk makes automatic selection unsafe
    Given I open the wizard with two internal disks
    Then in-place installation is "unavailable"
    And making installation media remains available
