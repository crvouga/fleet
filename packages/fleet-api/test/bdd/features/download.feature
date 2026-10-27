Feature: Recommend the installer for the computer opening Fleet
  Scenario: Detect the real computer running this browser
    When I open the Add node page
    Then the recommendation matches the computer running this browser

  Scenario Outline: Offer the matching installer directly
    Given I browse Fleet from "<device>"
    When I open the Add node page
    Then the recommended installer downloads "<file>"
    And all other installers remain available

    Examples:
      | device            | file                              |
      | Windows x64       | fleet-installer-windows-x64.exe    |
      | Windows WOW64     | fleet-installer-windows-x64.exe    |
      | Mac Apple silicon | fleet-installer-macos-arm64.zip    |
      | Mac Intel         | fleet-installer-macos-x64.zip      |
      | Linux x64         | fleet-installer-linux-x64.tar.gz   |
      | Linux ARM64       | fleet-installer-linux-arm64.tar.gz |

  Scenario Outline: Do not guess when the browser cannot identify a supported installer
    Given I browse Fleet from "<device>"
    When I open the Add node page
    Then no installer is incorrectly recommended
    And all other installers remain available

    Examples:
      | device         |
      | Mac hidden chip |
      | Mac denied hints |
      | Mac stuck hints |
      | Linux unknown  |
      | Windows ARM64  |
      | Windows 32-bit |
      | iPhone         |
      | iPad desktop   |
      | Android        |
      | ChromeOS       |
      | Unknown        |

  Scenario: NixOS uses its native installer rather than the Linux executable
    Given I browse Fleet from "NixOS"
    When I open the Add node page
    Then the native NixOS installation instructions are recommended

  Scenario: Select a different computer for the download
    Given I browse Fleet from "Mac Apple silicon"
    When I open the Add node page
    And I select "windows-x64" as the installer platform
    Then the selected installer downloads "fleet-installer-windows-x64.exe"

  Scenario: A late browser hint does not override a manual choice
    Given I browse Fleet from "Mac slow hints"
    When I open the Add node page
    And I select "windows-x64" as the installer platform
    Then the selected installer stays "fleet-installer-windows-x64.exe" after detection finishes

  Scenario: Select NixOS when the browser reports generic Linux
    Given I browse Fleet from "Linux x64"
    When I open the Add node page
    And I select "nixos" as the installer platform
    Then the native NixOS installation instructions are recommended

  Scenario: Return to automatic detection after choosing a different platform
    Given I browse Fleet from "Mac Apple silicon"
    When I open the Add node page
    Then the recommended installer downloads "fleet-installer-macos-arm64.zip"
    When I select "windows-x64" as the installer platform
    And I select "" as the installer platform
    Then the recommended installer downloads "fleet-installer-macos-arm64.zip"

  @nojs
  Scenario: Downloads remain usable with JavaScript disabled
    Given JavaScript is disabled in my browser
    When I open the Add node page
    Then all other installers remain available

  @local
  Scenario: A manual platform choice survives dashboard auto-refresh
    Given I browse Fleet from "Mac Apple silicon"
    When I open the empty fleet overview
    Then the recommended installer downloads "fleet-installer-macos-arm64.zip"
    When I select "windows-x64" as the installer platform
    And the dashboard refreshes automatically
    Then the selected installer downloads "fleet-installer-windows-x64.exe"

  @live
  Scenario: Download the recommended Windows executable from the deployed page
    Given I browse Fleet from "Windows x64"
    When I open the Add node page
    And I download the recommended installer
    Then the executable matches its published size and SHA-256
