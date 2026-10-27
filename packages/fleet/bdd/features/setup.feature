@local
Feature: Recover GitHub runner App setup after authentication
  Scenario: Retry the manifest after GitHub loses it during authentication
    Given I open the real runner App setup form without reverse DNS
    When I start creating the runner App in GitHub
    And GitHub requires me to confirm access and loses the manifest
    Then the original setup form is still available
    When I submit the setup form again
    Then GitHub receives the same private runner App manifest
    When I approve the runner App
    Then the real setup callback confirms that the App was created
