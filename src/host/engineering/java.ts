import { diagnostic, findExecutable, has, matches, missing, probe, type Adapter, type Proposal } from './toolchain.js';

export const java: Adapter = {
  id: 'java',
  async detect(root) {
    const maven = has(root, 'pom.xml');
    const gradle = has(root, 'build.gradle') || has(root, 'build.gradle.kts');
    if (!maven && !gradle) return [];
    const javaExe = findExecutable('java');
    const jdk = javaExe && await probe(javaExe, ['-version']);
    const found: Proposal[] = [];
    if (maven) {
      const wrapper = has(root, 'mvnw.cmd');
      const problem = !javaExe ? missing('java') : !wrapper && !findExecutable('mvn') ? missing('mvn') : undefined;
      found.push({ label: 'Maven 测试', command: wrapper ? '.\\mvnw.cmd test' : 'mvn test', timeoutSeconds: 900, toolchain: jdk, problem });
    }
    if (gradle) {
      const wrapper = has(root, 'gradlew.bat');
      const problem = !javaExe ? missing('java') : !wrapper && !findExecutable('gradle') ? missing('gradle') : undefined;
      found.push({ label: 'Gradle 测试', command: wrapper ? '.\\gradlew.bat test' : 'gradle test', timeoutSeconds: 900, toolchain: jdk, problem });
    }
    return found;
  },
  parse(output) {
    const tests = [
      // Surefire 汇总：[ERROR]   CalculatorTest.discountReducesThePrice:15 expected: <80> but was: <120>
      ...matches(output, /^\[ERROR\]\s{2,}(?:Run \d+: )?([\w$.]+\.[\w$]+)(?::\d+)?\s/m).map(match => match[1]),
      // Surefire 逐个结果：[ERROR] discountReducesThePrice  Time elapsed: 0.01 s  <<< FAILURE!
      ...matches(output, /^\[ERROR\] ([\w$.]+)(?:\([\w$.]+\))?\s+Time elapsed:.*<<< (?:FAILURE|ERROR)!/m).map(match => match[1]),
      // Gradle：CalculatorTest > discountReducesThePrice() FAILED
      ...matches(output, /^([\w$.]+) > ([\w$]+)\(.*\) FAILED/m).map(match => `${match[1]}.${match[2]}`),
    ];
    const diagnostics = [
      // Maven 编译器：[ERROR] /E:/x/src/Calc.java:[12,5] cannot find symbol
      ...matches(output, /^\[(ERROR|WARNING)\] \/?([^[\r\n]+?\.java):\[(\d+),(\d+)\] (.+)$/m)
        .map(match => diagnostic(match[2], match[3], match[4], match[5], match[1] === 'ERROR' ? 'error' : 'warning')),
      // javac / Gradle：src\Calc.java:12: error: cannot find symbol
      ...matches(output, /^([^\s:][^:\r\n]*?\.java):(\d+): (error|warning): (.+)$/m).map(match => diagnostic(match[1], match[2], undefined, match[4], match[3] as 'error')),
    ];
    return { tests, diagnostics };
  },
};
