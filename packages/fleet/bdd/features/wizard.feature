@local
Feature: Safely download and write the fleet installer
  Scenario: Run the installer built for this revision
    Given I open the installer wizard with a published image and a simulated USB disk
    Then the wizard reports the expected build revision

  Scenario: Write a verified installer only after an explicit confirmation
    Given I open the installer wizard with a published image and a simulated USB disk
    When I choose the USB disk and review the installation
    And I try to install without confirming the erase
    Then the simulated disk has not changed
    When I confirm the erase and install
    Then the wizard reports a verified installation
    And the simulated disk contains the published image

  Scenario: Refuse installation when the image download is missing
    Given I open the installer wizard with an unavailable image
    Then the wizard explains that the download cannot be reached
    And the simulated disk has not changed
