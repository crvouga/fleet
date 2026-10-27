@live
Feature: Install from the actual published fleet release
  Scenario: The dashboard offers a native NixOS install and reinstall path
    Given I have owner access to the deployed Fleet dashboard
    When I open the deployed Add node page
    Then the page offers the native NixOS installer and hard reinstall guide

  Scenario: Download the Windows installer from the deployed Add node page
    Given I have owner access to the deployed Fleet dashboard
    When I open the deployed Add node page
    And I follow its installer release link
    Then the real GitHub release lists the Windows installer
    When I download the published Windows installer
    Then the downloaded executable matches its published size and SHA-256

  Scenario Outline: Every supported platform has a working public download
    When I request the published download "<filename>"
    Then the public download returns HTTP 200

    Examples:
      | filename                               |
      | fleet-installer-windows-x64.exe         |
      | fleet-installer-macos-arm64.zip         |
      | fleet-installer-macos-x64.zip           |
      | fleet-installer-linux-arm64.tar.gz      |
      | fleet-installer-linux-x64.tar.gz        |

  Scenario: All parts needed to assemble the offline image are published
    When I fetch the real installer image manifest
    Then every image part is reachable and matches its published size and checksum

  Scenario: The configured GitHub App can authorize a private Actions runner
    Given the configured runner App is installed on its private repository
    When it requests a runner registration token
    Then GitHub authorizes runner registration without exposing the token
