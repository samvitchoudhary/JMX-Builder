import { escapeXml, parseUrl } from './utils.js';

/*
 * JMeter ResponseAssertion test_type bitfield (from org.apache.jmeter.assertions.ResponseAssertion):
 *   1  = MATCH      (regex, full string)
 *   2  = CONTAINS   (regex find)
 *   4  = NOT        (modifier)
 *   8  = EQUALS     (literal equality)
 *   16 = SUBSTRING  (literal substring, not regex)
 *
 * We use 8 (EQUALS) for response codes and 16 (SUBSTRING) for body contains.
 */
const TEST_TYPE_EQUALS = 8;
const TEST_TYPE_SUBSTRING = 16;

/**
 * Build a JMeter .jmx XML string from a config object.
 *
 * config = {
 *   testPlanName, threadGroupName,
 *   url,
 *   threads, rampUp, loops,
 *   assertions: {
 *     responseCode:  { enabled, value },   // value: string like "200"
 *     responseTime:  { enabled, value },   // value: ms as string/number
 *     bodyContains:  { enabled, value },   // value: substring
 *   }
 * }
 */
export function buildJmx(config) {
  const {
    testPlanName,
    threadGroupName,
    url,
    threads,
    rampUp,
    loops,
    assertions,
  } = config;

  const { protocol, hostname, port, path } = parseUrl(url);

  const tpName = escapeXml(testPlanName || 'Test Plan');
  const tgName = escapeXml(threadGroupName || 'Thread Group');
  const httpName = escapeXml('HTTP Request');

  const numThreads = Math.max(1, parseInt(threads, 10) || 1);
  const ramp = Math.max(0, parseInt(rampUp, 10) || 0);
  const loopCount = Math.max(1, parseInt(loops, 10) || 1);

  const assertionXml = buildAssertions(assertions);

  return `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="${tpName}" enabled="true">
      <stringProp name="TestPlan.comments"></stringProp>
      <boolProp name="TestPlan.functional_mode">false</boolProp>
      <boolProp name="TestPlan.tearDown_on_shutdown">true</boolProp>
      <boolProp name="TestPlan.serialize_threadgroups">false</boolProp>
      <elementProp name="TestPlan.user_defined_variables" elementType="Arguments" guiclass="ArgumentsPanel" testclass="Arguments" testname="User Defined Variables" enabled="true">
        <collectionProp name="Arguments.arguments"/>
      </elementProp>
      <stringProp name="TestPlan.user_define_classpath"></stringProp>
    </TestPlan>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="${tgName}" enabled="true">
        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="Loop Controller" enabled="true">
          <boolProp name="LoopController.continue_forever">false</boolProp>
          <stringProp name="LoopController.loops">${loopCount}</stringProp>
        </elementProp>
        <stringProp name="ThreadGroup.num_threads">${numThreads}</stringProp>
        <stringProp name="ThreadGroup.ramp_time">${ramp}</stringProp>
        <boolProp name="ThreadGroup.scheduler">false</boolProp>
        <stringProp name="ThreadGroup.duration"></stringProp>
        <stringProp name="ThreadGroup.delay"></stringProp>
        <boolProp name="ThreadGroup.same_user_on_next_iteration">true</boolProp>
      </ThreadGroup>
      <hashTree>
        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${httpName}" enabled="true">
          <stringProp name="HTTPSampler.domain">${escapeXml(hostname)}</stringProp>
          <stringProp name="HTTPSampler.port">${escapeXml(port)}</stringProp>
          <stringProp name="HTTPSampler.protocol">${escapeXml(protocol)}</stringProp>
          <stringProp name="HTTPSampler.contentEncoding"></stringProp>
          <stringProp name="HTTPSampler.path">${escapeXml(path)}</stringProp>
          <stringProp name="HTTPSampler.method">GET</stringProp>
          <boolProp name="HTTPSampler.follow_redirects">true</boolProp>
          <boolProp name="HTTPSampler.auto_redirects">false</boolProp>
          <boolProp name="HTTPSampler.use_keepalive">true</boolProp>
          <boolProp name="HTTPSampler.DO_MULTIPART_POST">false</boolProp>
          <stringProp name="HTTPSampler.embedded_url_re"></stringProp>
          <stringProp name="HTTPSampler.connect_timeout"></stringProp>
          <stringProp name="HTTPSampler.response_timeout"></stringProp>
          <elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="User Defined Variables" enabled="true">
            <collectionProp name="Arguments.arguments"/>
          </elementProp>
        </HTTPSamplerProxy>
        <hashTree>
${assertionXml}
        </hashTree>
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>
`;
}

function buildAssertions(assertions = {}) {
  const blocks = [];

  if (assertions.responseCode?.enabled) {
    blocks.push(
      buildResponseAssertion({
        testname: 'Response Code Assertion',
        testField: 'Assertion.response_code',
        testType: TEST_TYPE_EQUALS,
        value: String(assertions.responseCode.value ?? '200'),
      })
    );
  }

  if (assertions.responseTime?.enabled) {
    blocks.push(
      buildDurationAssertion(
        Math.max(0, parseInt(assertions.responseTime.value, 10) || 0)
      )
    );
  }

  if (assertions.bodyContains?.enabled) {
    blocks.push(
      buildResponseAssertion({
        testname: 'Body Contains Assertion',
        testField: 'Assertion.response_data',
        testType: TEST_TYPE_SUBSTRING,
        value: String(assertions.bodyContains.value ?? ''),
      })
    );
  }

  return blocks.join('\n');
}

function buildResponseAssertion({ testname, testField, testType, value }) {
  // The "Asserion.test_strings" typo is intentional — JMeter persists this
  // misspelled key in serialized test plans and rejects the corrected form.
  return `          <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="${escapeXml(testname)}" enabled="true">
            <collectionProp name="Asserion.test_strings">
              <stringProp name="jmx_builder_value">${escapeXml(value)}</stringProp>
            </collectionProp>
            <stringProp name="Assertion.custom_message"></stringProp>
            <stringProp name="Assertion.test_field">${testField}</stringProp>
            <boolProp name="Assertion.assume_success">false</boolProp>
            <intProp name="Assertion.test_type">${testType}</intProp>
          </ResponseAssertion>
          <hashTree/>`;
}

function buildDurationAssertion(ms) {
  return `          <DurationAssertion guiclass="DurationAssertionGui" testclass="DurationAssertion" testname="Response Time Assertion" enabled="true">
            <stringProp name="DurationAssertion.duration">${ms}</stringProp>
          </DurationAssertion>
          <hashTree/>`;
}
