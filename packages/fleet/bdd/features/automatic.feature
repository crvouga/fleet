@local
Feature: Minimize manual steps on every installer platform
  Scenario Outline: Prepare a USB and reconnect after a reload without repeating the write
    Given I open the USB wizard on "<os>" with "<arch>" hardware
    When I review the automatically selected USB
    And I confirm the erase and install
    Then the wizard reports a verified installation
    When I reload the installer page
    Then the wizard reports a verified installation
    And the simulated disk contains the published image

    Examples:
      | os      | arch    |
      | Windows | AMD64   |
      | Darwin  | x86_64  |
      | Darwin  | arm64   |
      | Linux   | x86_64  |
      | Linux   | aarch64 |

  Scenario: CI installation does not ask for unrelated devbox access
    Given I open the wizard on "Linux" with "x86_64" hardware
    When I choose the CI runner role
    Then SSH key and manual enrollment fields stay out of the normal flow

  Scenario: Review a hidden WPA3 Wi-Fi handoff without exposing its password
    Given I open the USB wizard on "Windows" with "AMD64" hardware
    When I review a USB with explicit hidden WPA3 Wi-Fi settings
    Then the Wi-Fi password stays private and disk consent is still required
